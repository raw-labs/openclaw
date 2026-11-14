#!/bin/sh
set -eu

attachment_url='https://github.com/user-attachments/assets/6d740f07-5212-4dab-8b4c-0895e6f270d1'
output_file='pr-197402-live-proof.mp4'
partial_file=$(mktemp "./.${output_file}.XXXXXX")
trap 'rm -f "$partial_file"' EXIT
trap 'exit 1' HUP INT TERM

github_token=$(gh auth token --hostname github.com)
printf 'header = "Authorization: Bearer %s"\n' "$github_token" |
  curl --config - --fail --silent --show-error --location --max-time 60 \
    --output "$partial_file" "$attachment_url"
unset github_token

expected_sha='4975b231e0f028c29810a4a786c654a7027be87ebaaa1dc7aa8d515e6438c125'
if command -v sha256sum >/dev/null 2>&1; then
  actual_sha=$(sha256sum "$partial_file")
else
  actual_sha=$(shasum -a 256 "$partial_file")
fi
if [ "${actual_sha%% *}" != "$expected_sha" ]; then
  printf '%s\n' "Video checksum mismatch." >&2
  exit 1
fi

mv "$partial_file" "$output_file"
printf 'Saved %s\n' "$output_file"
