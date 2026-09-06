// src/lib/errorMessage.ts
//
// Supabase(PostgREST/RPC) 에러, JS Error, 순수 객체, 문자열 등
// 어떤 형태로 던져지든 사용자에게 보여줄 문자열을 안전하게 추출한다.
//
// 문제 배경: Supabase JS 클라이언트가 RPC 실패 시 throw하는 값은
// Error 인스턴스가 아니라 PostgrestError 형태의 일반 객체
// ({ message, details, hint, code })일 수 있다.
// 기존 코드의 `err instanceof Error ? err.message : String(err)` 패턴은
// 이 경우 String(plainObject)가 "[object Object]"를 반환해 화면에
// 의미 없는 문자열만 노출시키는 버그를 만든다.
// 이 함수는 message/error_description/error 필드를 우선 탐색해 실제 내용을 뽑아낸다.

export function toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;

    if (typeof err === 'string') return err;

    if (err && typeof err === 'object') {
        const obj = err as Record<string, unknown>;
        const candidate = obj.message ?? obj.error_description ?? obj.error ?? obj.hint;
        if (typeof candidate === 'string' && candidate.length > 0) {
            const code = obj.code ? ` (code: ${obj.code})` : '';
            return `${candidate}${code}`;
        }
        try {
            return JSON.stringify(obj);
        } catch {
            return '알 수 없는 오류가 발생했습니다.';
        }
    }

    return '알 수 없는 오류가 발생했습니다.';
}
