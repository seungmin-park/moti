import Link from "next/link";
import { Bookmark, CircleAlert } from "lucide-react";
import type { LoginNotice } from "./login-notice";

export function LoginScreen({ notice }: { notice: LoginNotice | null }) {
  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <p className="brand">
          <span className="brand-mark">
            <Bookmark size={24} strokeWidth={2.1} />
          </span>
          moti<span className="brand-dot">.</span>
        </p>
        <h1 id="login-title">내 보관함 열기</h1>
        <p className="login-lead">허용한 Google 계정으로 로그인하면 담아둔 물건을 볼 수 있어요.</p>
        {notice && (
          <div className="form-error login-notice" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <div>
              <strong>{notice.title}</strong>
              <p>{notice.detail}</p>
            </div>
          </div>
        )}
        {/* A plain anchor: Link prefetching would start OAuth and set the PKCE cookie. */}
        <a className="button primary full" href="/auth/login">
          Google 계정으로 계속하기
        </a>
        <Link className="login-demo" href="/demo">
          예시 데이터로 둘러보기
        </Link>
      </section>
    </main>
  );
}
