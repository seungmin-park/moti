import type { Metadata } from "next";
import { LoginScreen } from "@/features/auth/screen/LoginScreen";
import { loginNotice } from "@/features/auth/screen/login-notice";

export const metadata: Metadata = { title: "moti · 로그인" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  return <LoginScreen notice={loginNotice(error)} />;
}
