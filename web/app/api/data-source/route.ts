import { NextResponse } from 'next/server';
import { dataSourceInfo } from '@/lib/mock';

export const dynamic = 'force-dynamic';

// 当前数据源：'shopify'(已同步真实数据) 或 'mock'(演示数据)
export function GET() {
  return NextResponse.json(dataSourceInfo());
}