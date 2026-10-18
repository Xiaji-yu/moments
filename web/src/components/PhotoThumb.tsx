import { useEffect, useState } from 'react';
import { authBlob } from '../api';

interface Props {
  photoId: string;
}

/**
 * 带鉴权的缩略图加载（Bash 之外无法用 <img src> 直接带 Header）。
 * 用绝对定位铺满父容器：父级必须是 relative + 固定宽高比（如 aspect-square），
 * 否则 img 的 h-full 会反过来把容器撑成图片自身比例，网格里每张高度不一致。
 */
export function PhotoThumb({ photoId }: Props) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    let objectUrl: string | null = null;
    authBlob(`/photos/${photoId}/thumb`)
      .then((blob) => {
        if (dead) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      dead = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photoId]);

  if (!url) return <div className="absolute inset-0 animate-pulse bg-paper-2" />;
  return (
    <img
      src={url}
      alt=""
      className="absolute inset-0 h-full w-full object-cover"
      draggable={false}
    />
  );
}
