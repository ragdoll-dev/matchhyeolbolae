// src/lib/supabaseClient.ts
//
// Supabase 클라이언트 초기화.
// 큐플레이 클론은 회원가입 없이 닉네임만으로 입장하는 게스트 플레이가 핵심이므로,
// 세션이 없으면 즉시 익명 로그인(signInAnonymously)을 수행해 auth.uid()를 확보한다.
//
// ⚠️ 사전 조건: Supabase 대시보드 → Authentication → Sign In / Providers →
//   "Anonymous Sign-Ins" 를 활성화해야 signInAnonymously가 동작한다.
//   비활성 상태에서 호출하면 "Anonymous sign-ins are disabled" 에러가 발생한다.

import { createClient, type Session } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';

export const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
	auth: {
		persistSession: true,
		autoRefreshToken: true,
		detectSessionInUrl: false
	}
});

/**
 * 현재 세션이 없으면 익명 로그인을 수행하고, 있으면 기존 세션을 반환한다.
 * 방 생성/참가 페이지 진입 시 반드시 이 함수를 먼저 호출해서
 * auth.uid()가 채워진 상태를 보장해야 create_room / join_room RPC가 정상 동작한다.
 */
export async function ensureAnonymousSession(): Promise<Session> {
	const { data: existing } = await supabase.auth.getSession();
	if (existing.session) {
		return existing.session;
	}

	const { data, error } = await supabase.auth.signInAnonymously();
	if (error) {
		throw new Error(`익명 로그인 실패: ${error.message}`);
	}
	if (!data.session) {
		throw new Error('익명 로그인은 성공했지만 세션이 반환되지 않았습니다.');
	}
	return data.session;
}
