'use client';

import { useRef } from 'react';
import { LOCAL_ASSET_PREFIX } from '@/lib/edm/html';
import { ASSET_MAX_BYTES, type Asset } from '@/lib/edm/types';
import styles from './designer.module.css';

/**
 * 素材库弹窗。列表与增删都由设计器持有（设计器需要素材 ID 做 lint），
 * 这里只负责展示与交互。
 */
export function AssetPicker(props: {
  open: boolean;
  title: string;
  hint?: string;
  assets: Asset[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onPick: (asset: Asset) => void;
  onUpload: (file: File) => void;
  onDelete: (asset: Asset) => void;
}): React.ReactElement {
  const fileRef = useRef<HTMLInputElement | null>(null);
  if (!props.open) return <></>;

  return (
    <div className={styles.modalMask} onClick={props.onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <b>{props.title}</b>
          <div className={styles.spacer} />
          <button className={styles.smallBtn} onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className={styles.modalBody}>
          {props.hint && <div className={styles.modalHint}>{props.hint}</div>}
          <div className={styles.rowActions}>
            <input
              ref={fileRef}
              className={styles.hiddenInput}
              type="file"
              accept="image/png,image/jpeg,image/gif"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) props.onUpload(file);
              }}
            />
            <button className={styles.primaryBtn} disabled={props.busy} onClick={() => fileRef.current?.click()}>
              {props.busy ? '处理中…' : '上传新素材'}
            </button>
            <span className={styles.muted}>
              支持 PNG / JPEG / GIF，单张不超过 {Math.round(ASSET_MAX_BYTES / 1024 / 1024)} MB
            </span>
          </div>
          {props.error && <div className={styles.errBox}>{props.error}</div>}
          {props.assets.length === 0 ? (
            <div className={styles.emptyBox}>素材库还是空的，先上传一张图片。</div>
          ) : (
            <div className={styles.assetGrid}>
              {props.assets.map((asset) => (
                <div key={asset.id} className={styles.assetCell}>
                  <button
                    className={styles.assetPick}
                    disabled={props.busy}
                    title="点击使用该素材"
                    onClick={() => props.onPick(asset)}
                  >
                    <img
                      className={styles.assetThumb}
                      src={`${LOCAL_ASSET_PREFIX}${asset.id}`}
                      alt={asset.filename}
                    />
                  </button>
                  <div className={styles.assetName} title={asset.filename}>
                    {asset.filename}
                  </div>
                  <div className={styles.assetMeta}>
                    <span>{formatBytes(asset.size)}</span>
                    <span className={asset.uploaded ? styles.badgeGreen : styles.badge}>
                      {asset.uploaded ? '已上传' : '未上传'}
                    </span>
                  </div>
                  <button
                    className={styles.assetDelete}
                    disabled={props.busy}
                    onClick={() => props.onDelete(asset)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className={styles.modalFoot}>
          <span className={styles.muted}>
            素材在设计稿里用 {LOCAL_ASSET_PREFIX}&lt;id&gt; 引用；推送 Klaviyo 前会统一上传为公开地址。
          </span>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}