import { LoadingScreen } from "@/components/LoadingScreen";

/**
 * Route-level loading UI, shown by Next.js while a server component streams in.
 * Delegates to the shared {@link LoadingScreen} so section-specific loading
 * states can reuse the same terminal aesthetic.
 */
export default function Loading() {
  return (
    <LoadingScreen
      command="ssh connect"
      steps={["resolving host", "negotiating key exchange", "authenticating"]}
    />
  );
}
