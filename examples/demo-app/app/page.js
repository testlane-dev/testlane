import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "../lib/auth.js";
import SignOutButton from "./sign-out-button.js";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) redirect("/login");

  return (
    <main>
      <h1>Testlane demo</h1>
      <p data-testid="whoami">
        Signed in as <strong>{session.user.email}</strong> ({session.user.role ?? "no role"})
      </p>
      <p>
        <a href="/api/me">/api/me</a>
      </p>
      <SignOutButton />
    </main>
  );
}
