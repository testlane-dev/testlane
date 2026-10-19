"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

const field = { display: "block", width: "100%", padding: 8, margin: "4px 0 12px", boxSizing: "border-box" };

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const res = await signIn("credentials", {
      email: form.get("email"),
      password: form.get("password"),
      redirect: false,
    });
    setBusy(false);
    if (res?.ok && !res.error) {
      router.replace("/");
      router.refresh();
    } else {
      setError("Sign-in failed.");
    }
  }

  return (
    <main>
      <h1>Sign in</h1>
      <p>
        Humans type a password here. Agents never do: the broker signs in for them
        (<code>testlane session</code>) or hands their browser a one-time URL
        (<code>testlane handoff</code>).
      </p>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required style={field} />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required style={field} />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </main>
  );
}
