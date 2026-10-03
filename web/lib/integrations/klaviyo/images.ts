import { klaviyoFetch } from './client';
import { klaviyoConfig, type KlaviyoConfig } from './config';
import type { AssetMime } from '@/lib/edm/types';
import { extForMime } from '@/lib/edm/html';

// 图片上传。
//
// 官方约束：multipart 字段名为 file，另有可选的 name / hidden；
// 支持 jpeg、png、gif，最大 5 MB；没有 alt_text 字段。
// 返回的 data.attributes.image_url 是可以直接放进邮件的公开地址。

export type UploadedImage = { id: string; url: string; name: string };

type ImageAttributes = { name?: string | null; image_url?: string | null; format?: string | null; size?: number | null };

export async function uploadImage(
  input: { filename: string; mime: AssetMime; body: Buffer; name?: string },
  cfg: KlaviyoConfig | null = klaviyoConfig(),
): Promise<UploadedImage> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(input.body)], { type: input.mime }), input.filename || `image.${extForMime(input.mime)}`);
  if (input.name) form.append('name', input.name);

  const body = await klaviyoFetch<{ data?: { id: string; attributes?: ImageAttributes } }>(
    {
      method: 'POST',
      path: '/api/image-upload',
      formData: form,
      // 上传不是幂等操作：超时结果不明，不自动重发
      idempotent: false,
      timeoutMs: 60_000,
    },
    cfg,
  );

  const url = body?.data?.attributes?.image_url;
  const id = body?.data?.id;
  if (!id || !url) throw new Error('Klaviyo 未返回图片地址');
  return { id, url, name: body?.data?.attributes?.name ?? input.filename };
}