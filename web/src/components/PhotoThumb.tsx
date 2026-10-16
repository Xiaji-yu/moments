import { useEffect, useState } from 'react';
import { authBlob } from '../api';

interface Props {
  photoId: string;
}

/** 带鉴权的缩略图加载（Bash 之外无法用 <img src> 直接带 Header） */
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

  if (!url) return <div className="h-full w-full animate-pulse bg-gray-200" />;
  return <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />;
}
