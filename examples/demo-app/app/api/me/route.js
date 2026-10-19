import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth.js";

export const dynamic = "force-dynamic";

/** GET /api/me -> { email, role } for the signed-in user, 401 otherwise. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  return Response.json({ email: session.user.email, role: session.user.role ?? null });
}
