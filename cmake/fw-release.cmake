# The single pin tying this extension to a firmware release. Bumping to a
# new firmware release = editing these two lines. The sha256 is the digest
# of the rgbx-sdk-<ver>.tar.gz asset on that release (GitHub shows it on
# the release page; or sha256sum the downloaded file).
set(RGBX_FW_RELEASE "fw-v3.1.1")
set(RGBX_SDK_SHA256 "8c8d53972baf0c37fec5c94e02f6d9d3edf1d4d8eca1b32a1394f99f21b17bb2")
