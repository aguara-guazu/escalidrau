const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

// identity:null skips electron-builder signing entirely, which leaves the
// bundle with a bare linker signature and no resource seal. Re-seal the whole
// bundle ad-hoc so the signature is at least internally consistent.
// Distribution to other Macs still requires Developer ID + notarization.
exports.default = async (context) => {
  if (context.electronPlatformName !== "darwin") {
    return;
  }
  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit"
  });
};
