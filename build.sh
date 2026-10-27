#!/bin/sh
# Builds the release zips into dist/. Chrome and Firefox each get a manifest with only
# the background key they support, so neither browser shows a warning.
set -eu
cd "$(dirname "$0")"
rm -rf dist
for b in chrome firefox; do
  mkdir -p "dist/$b"
  cp background.js content.js content.css LICENSE "dist/$b/"
done
python3 - <<'PY'
import json
m = json.load(open('manifest.json'))
for browser, key in [('chrome', 'service_worker'), ('firefox', 'scripts')]:
    out = dict(m, background={key: m['background'][key]})
    json.dump(out, open(f'dist/{browser}/manifest.json', 'w'), indent=2)
PY
(cd dist/chrome && zip -X -q ../Canvas-Bulk-Downloader-Chrome.zip ./*)
(cd dist/firefox && zip -X -q ../Canvas-Bulk-Downloader-Firefox.zip ./*)
echo "Built dist/Canvas-Bulk-Downloader-Chrome.zip and dist/Canvas-Bulk-Downloader-Firefox.zip"
