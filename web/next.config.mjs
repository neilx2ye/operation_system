/** @type {import('next').NextConfig} */
const nextConfig = {
  // 允许验证时使用隔离的构建目录（NEXT_DIST_DIR=.next-verify），
  // 避免覆盖正在运行的开发服务器使用的 .next。不设置时行为与默认完全一致。
  distDir: process.env.NEXT_DIST_DIR || '.next',

  // Next 16 默认拦截「非服务器绑定主机」对开发资源（/_next/*、HMR WebSocket）的跨源访问，
  // 会导致通过 127.0.0.1 或局域网 IP 打开时页面卡在加载中、热重载失效。
  // 这里把常用开发访问来源加白名单；修改后需重启 dev server 生效。
  allowedDevOrigins: ['localhost', '127.0.0.1', '10.4.0.17', '*.local'],
};

export default nextConfig;
