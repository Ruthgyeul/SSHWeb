import { OgImage, alt, size, contentType } from "@/lib/og";

// Re-export the metadata Next.js reads to build the <meta name="twitter:image"> tag.
export { alt, size, contentType };

export default function Image() {
  return OgImage();
}
