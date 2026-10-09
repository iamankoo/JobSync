import { redirect } from "next/navigation";
import { LoginScreen } from "@/components/auth/login-screen";
import { getSession } from "@/lib/auth/session";

export const metadata = { title: "Sign in · JobSync" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getSession()) redirect("/dashboard");
  return <LoginScreen />;
}
