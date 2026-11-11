# Official npm packages on OpenVibe Git

The forge serves public, immutable versions of `openvibe-contracts`, `openvibe-sdk`, `openvibe-shared`, and `openvibe-publishing` at `https://git.openvibe.codes/api/packages/openvibers/npm/`. Reads and tarballs are public. Publishing requires the forge runner credential as a Bearer token. The registry accepts npm's single-version `PUT` publish body; a version cannot be replaced.

The release owner publishes an existing library release with `npm publish --registry=https://git.openvibe.codes/api/packages/openvibers/npm/` after configuring npm authentication through the approved credential channel. Do not put the credential in a repository or a command argument. Check `npm view <name>@<version> dist --registry=https://git.openvibe.codes/api/packages/openvibers/npm/` and install in a clean project before changing a dependency pin.

The first consumer should pin one of these libraries by semver and set its registry to the forge URL for that install. Run `npm ci` with npm 10 and npm 12 before moving another repository. Existing codeload pins stay valid for old releases.

This is the Release 2 registry spike. It supports publish, metadata, tarball download, and install. Dist-tag editing, deletion, and arbitrary packages are outside the spike.
