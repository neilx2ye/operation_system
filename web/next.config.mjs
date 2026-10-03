/** @type {import('next').NextConfig} */
const nextConfig = {
  // 允许验证时使用隔离的构建目录（NEXT_DIST_DIR=.next-verify），
  // 避免覆盖正在运行的开发服务器使用的 .next。不设置时行为与默认完全一致。
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

export default nextConfig;