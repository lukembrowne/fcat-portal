import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
