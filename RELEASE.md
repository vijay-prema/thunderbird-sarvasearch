# How to create a signed release

If you dont sign the extension using a Thunderbird developer account, then users need to set `xpinstall.signatures.required=false` in Thunderbird config editor.

```sh
# Build unsigned extension
./build.sh
# Sign the xpi (as unlisted) using Developer Hub https://addons.thunderbird.net/en-US/developers/addons
# Download the signed xpi for later upload using `gh release create...` below

# Create tag
git tag -a v3.0.0 -m "SarvaSearch 3.0.0"
# Push tag
git push origin v3.0.0
# Create release, can use blank release notes as draft if you dont want to generate from commit messages.
gh release create v3.0.0 sarvasearch-3.0.0-tb.xpi \
           -R vijay-prema/thunderbird-sarvasearch \
           --title "SarvaSearch 3.0.0"
# Edit the release notes and publish in github
```