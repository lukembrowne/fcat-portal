"use client";

import { useState } from "react";
import Image from "next/image";

const PAGE_SIZE = 50;

interface PublicImage {
  id: number;
  filename: string;
}

interface PublicImageGridProps {
  images: PublicImage[];
  token: string;
  totalCount: number;
}

export function PublicImageGrid({ images, token, totalCount }: PublicImageGridProps) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const visibleImages = images.slice(0, visibleCount);
  const hasMore = visibleCount < totalCount;

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
        {visibleImages.map((img) => (
          <div
            key={img.id}
            className="aspect-[4/3] relative bg-muted rounded-lg overflow-hidden"
          >
            <Image
              src={`/api/public/ct-images/${token}/${img.id}?size=thumb`}
              alt={img.filename}
              fill
              className="object-cover"
              sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
              loading="lazy"
            />
          </div>
        ))}
      </div>

      {hasMore && (
        <div className="text-center mt-6">
          <button
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            className="px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            Cargar más ({totalCount - visibleCount} restantes)
          </button>
        </div>
      )}
    </div>
  );
}
