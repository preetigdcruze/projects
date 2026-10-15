/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: { remotePatterns: [{ protocol: "https", hostname: "**" }] },
  serverExternalPackages: ["@prisma/client", "bcryptjs"],
  poweredByHeader: false,
};
export default nextConfig;
