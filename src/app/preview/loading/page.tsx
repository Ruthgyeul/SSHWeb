import type { Metadata } from "next";
import { LoadingScreen } from "@/components/LoadingScreen";
import { SITE_NAME } from "@/config/siteConfig";

/**
 * Dedicated, full-screen preview of the shared {@link LoadingScreen}.
 *
 * Because Next.js only shows `loading.tsx` for the instant a segment streams,
 * this route renders the component at true viewport size so the loading state
 * can be inspected exactly as users see it. Use the browser back button to
 * return to the {@link file://../page.tsx preview gallery}.
 */
export const metadata: Metadata = {
  title: "LoadingScreen preview",
  description: `Full-screen preview of the loading state for ${SITE_NAME}.`,
  alternates: { canonical: "/preview/loading" },
};

export default function LoadingScreenPreview() {
  return (
    <LoadingScreen
      command="npm run build"
      steps={["compiled config", "resolved routes"]}
    />
  );
}
