#!/usr/bin/env bash
set -uo pipefail

EXPECTED_VERSION="${1:?usage: smoke-test-demo.sh <expected-version> [demo-url]}"
DEMO_URL="${2:-https://projektor-demo.tajdickson.workers.dev}"

fail=0
check() {
	local desc="$1"
	shift
	if "$@"; then
		echo "OK   - $desc"
	else
		echo "FAIL - $desc"
		fail=1
	fi
}

home_body_file="$(mktemp)"
home_headers="$(curl -sS -m 15 -D - -o "$home_body_file" "$DEMO_URL/")"
home_html="$(cat "$home_body_file")"
rm -f "$home_body_file"
version_line="$(grep -oE '<div class="sidebar-version">[^<]+</div>' <<<"$home_html")"
version="$(sed -E 's#.*>([^<]+)<.*#\1#' <<<"$version_line")"

check "footer version is $EXPECTED_VERSION (got '${version:-<none found>}')" \
	test "$version" = "$EXPECTED_VERSION"

check "no Cloudflare Access challenge on /" \
	bash -c '! grep -qi "cloudflareaccess.com" <<<"$1"' _ "$home_headers$home_html"

projects_response="$(curl -sS -m 15 -w '\n%{http_code}' "$DEMO_URL/api/projects")"
projects_status="$(tail -n1 <<<"$projects_response")"
projects_body="$(sed '$d' <<<"$projects_response")"

check "GET /api/projects returns 200 (got $projects_status)" \
	test "$projects_status" = "200"

check "GET /api/projects returns an empty list (still unseeded)" \
	bash -c '[[ "$1" == "[]" || "$1" =~ ^\{\"projects\":\[\]  ]]' _ "$projects_body"

if [ "$fail" -ne 0 ]; then
	echo
	echo "Demo response bodies for debugging:"
	echo "  /api/projects: $projects_body"
fi

exit "$fail"
