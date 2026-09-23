import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Next 16.3 type-checks the build with the real `tsc -p` (the new default,
  // experimental.useTypeScriptCli), which covers every file tsconfig.json
  // includes. Test files under src/ import tests/helpers/*, and .dockerignore
  // keeps tests/ out of the image build, so they must not be part of the build's
  // type-check. `npx tsc --noEmit` still checks them via tsconfig.json.
  typescript: {
    tsconfigPath: "tsconfig.build.json",
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
    proxyClientMaxBodySize: "50mb",
  },
  // Silence access-log spam for high-frequency polling endpoints. The
  // active-jobs hook is mounted on every page (floating-job-progress) and
  // polls every 3s while a job runs, drowning out everything else in the
  // dev logs.
  logging: {
    incomingRequests: {
      ignore: [/^\/api\/active-jobs/],
    },
  },
};

export default nextConfig;
