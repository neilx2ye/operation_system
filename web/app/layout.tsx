import type { Metadata } from 'next';
import './globals.css';
import { Nav } from '@/components/Nav';

export const metadata: Metadata = {
  title: 'OPS 电商管理 MVP',
  description: '产品 / 用户 / 关联分析（Mock 数据）',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}