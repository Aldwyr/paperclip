// Development and test builds resolve the workspace package here. Rebuild the package and restart
// the server after changing runner internals; the workspace export resolves through dist. The
// server build replaces this compiled shim with the package's built distribution, so published
// server installs do not need a separate paperclip-runner npm bootstrap.
export * from "@paperclipai/paperclip-runner";
