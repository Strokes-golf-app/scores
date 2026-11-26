#!/usr/bin/env python3
"""Safe, preview-first GPS backfill for Strokes Golf."""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("OPENGOLFAPI_BASE_URL", "https://api.opengolfapi.org").rstrip("/")
PAGE_SIZE = 500


def request(url, headers=None, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        message = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {exc.code}: {message[:350]}") from exc


def supabase_headers(key, extra=None):
    result = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if extra:
        result.update(extra)
    return result


def get_all_rows(base, key, table, fields):
    rows, offset = [], 0
    while True:
        url = f"{base}/rest/v1/{table}?select={fields}&limit={PAGE_SIZE}&offset={offset}"
        _, data = request(url, supabase_headers(key))
        rows.extend(data or [])
        if not data or len(data) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def normalize(value):
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def find_match(course):
    url = f"{API}/api/v1/courses/search?q={urllib.parse.quote(course['name'])}"
    _, payload = request(
        url,
        {"Accept": "application/json", "User-Agent": "StrokesGolf-GPS-backfill/1.0"},
    )
    results = payload.get("results", payload.get("courses", [])) if isinstance(payload, dict) else payload
    exact_name = normalize(course["name"])
    location_parts = [
        normalize(part)
        for part in (course.get("location") or "").split(",")
        if normalize(part)
    ]
    candidates = []

    for result in results if isinstance(results, list) else []:
        if not isinstance(result, dict) or not result.get("id"):
            continue
        names = {normalize(result.get("course_name")), normalize(result.get("club_name"))}
        names.discard("")
        if exact_name not in names:
            continue

        city = normalize(result.get("city"))
        state = normalize(result.get("state"))
        country = normalize(result.get("country_iso"))
        if location_parts and not any(
            part == city or part == state or part == country or part in city or part in state
            for part in location_parts
        ):
            continue
        candidates.append(result)

    unique = {str(item["id"]): item for item in candidates}
    return (next(iter(unique.values())) if len(unique) == 1 else None), list(unique.values())


def main():
    parser = argparse.ArgumentParser(description="Backfill GPS coordinates (preview by default).")
    parser.add_argument("--apply", action="store_true", help="Write matches to Supabase; default is preview only.")
    parser.add_argument("--delay", type=float, default=1, help="Seconds between API lookups.")
    args = parser.parse_args()

    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.")

    courses = get_all_rows(base, key, "courses", "id,name,location")
    gps_rows = get_all_rows(base, key, "golf_courses", "id,external_id,linked_course_id,lat,lng")
    linked_ids = {str(row["linked_course_id"]) for row in gps_rows if row.get("linked_course_id")}
    gps_by_external_id = {str(row["external_id"]): row for row in gps_rows}
    todo = [course for course in courses if str(course["id"]) not in linked_ids]

    print(f"Scoring courses: {len(courses)} | linked: {len(linked_ids)} | to check: {len(todo)}")
    if args.apply:
        print("APPLY MODE: matching records will be written.\n")
    else:
        print("PREVIEW MODE: no database changes. Review matches before using --apply.\n")

    summary = {"matched": 0, "ambiguous": 0, "not_found": 0, "written": 0, "errors": 0}

    for course in todo:
        label = f"{course.get('name')} — {course.get('location')}"
        try:
            match, alternatives = find_match(course)
            if not match:
                category = "ambiguous" if alternatives else "not_found"
                summary[category] += 1
                print(f"{category.upper()}: {label}" + (f" ({len(alternatives)} candidates)" if alternatives else ""))
                time.sleep(max(0, args.delay))
                continue

            lat, lng = match.get("lat"), match.get("lng")
            if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
                summary["not_found"] += 1
                print(f"NO COORDINATES: {label}")
                time.sleep(max(0, args.delay))
                continue

            row = {
                "external_id": str(match["id"]),
                "linked_course_id": course["id"],
                "course_name": match.get("course_name") or course["name"],
                "club_name": match.get("club_name"),
                "city": match.get("city"),
                "state": match.get("state"),
                "country_iso": match.get("country_iso"),
                "lat": lat,
                "lng": lng,
                "type": match.get("type"),
                "par": match.get("par"),
                "holes": match.get("holes"),
            }
            summary["matched"] += 1
            print(f"MATCH: {label} -> {lat}, {lng} (OpenGolfAPI ID {match['id']})")

            if args.apply:
                existing = gps_by_external_id.get(str(match["id"]))
                if existing and existing.get("linked_course_id") and str(existing["linked_course_id"]) != str(course["id"]):
                    print("  SKIPPED WRITE: GPS record is already linked to a different scoring course.")
                elif existing:
                    url = f"{base}/rest/v1/golf_courses?id=eq.{urllib.parse.quote(str(existing['id']))}"
                    request(url, supabase_headers(key, {"Prefer": "return=minimal"}), "PATCH", row)
                    summary["written"] += 1
                else:
                    request(
                        f"{base}/rest/v1/golf_courses",
                        supabase_headers(key, {"Prefer": "return=minimal"}),
                        "POST",
                        row,
                    )
                    summary["written"] += 1

        except Exception as exc:
            summary["errors"] += 1
            print(f"ERROR: {label}: {exc}")

        time.sleep(max(0, args.delay))

    print("\nSummary")
    for name, count in summary.items():
        print(f"  {name.replace('_', ' ').title()}: {count}")
    if not args.apply:
        print("  Database writes: 0 (preview only)")


if __name__ == "__main__":
    main()
