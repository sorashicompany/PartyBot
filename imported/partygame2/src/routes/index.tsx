import { createFileRoute } from "@tanstack/react-router";
import { PartyShow } from "@/components/party/show";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <PartyShow />;
}
