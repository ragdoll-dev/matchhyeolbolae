// src/lib/serverClock.ts
//
// 클라이언트-서버 시간 오프셋 측정 유틸리티 (NTP 스타일 알고리즘).
// (디버깅 로그 추가 버전 — 문제가 어느 단계에서 걸리는지 콘솔에서 바로 보이도록 함)

import { supabase } from '$lib/supabaseClient';

export interface TimeSample {
	offsetMs: number;
	roundTripMs: number;
}

async function measureOnce(index: number): Promise<TimeSample> {
	const t0 = Date.now();
	console.log(`[serverClock] 샘플 ${index} 요청 시작 (t0=${t0})`);

	const { data, error } = await supabase.rpc('get_server_time', {});

	const t2 = Date.now();
	console.log(`[serverClock] 샘플 ${index} 응답 도착 (t2=${t2})`, { data, error });

	if (error) {
		throw new Error(`서버 시각 조회 실패: ${error.message} (code: ${error.code ?? 'unknown'})`);
	}
	if (data === null || data === undefined) {
		throw new Error('서버 시각 응답이 비어있습니다 (data가 null/undefined).');
	}

	const serverTimeMs = new Date(data as string).getTime();
	if (Number.isNaN(serverTimeMs)) {
		throw new Error(`서버 시각 파싱 실패: 받은 값 = ${JSON.stringify(data)}`);
	}

	const roundTripMs = t2 - t0;
	const offsetMs = serverTimeMs - (t0 + t2) / 2;

	console.log(
		`[serverClock] 샘플 ${index} 계산 완료: offset=${offsetMs.toFixed(1)}ms, roundTrip=${roundTripMs}ms`
	);

	return { offsetMs, roundTripMs };
}

export async function measureServerOffset(sampleCount = 5): Promise<number> {
	const samples: TimeSample[] = [];

	for (let i = 0; i < sampleCount; i++) {
		try {
			const sample = await measureOnce(i + 1);
			samples.push(sample);
		} catch (err) {
			console.warn(`[serverClock] 샘플 ${i + 1} 실패:`, err);
		}
	}

	if (samples.length === 0) {
		throw new Error('서버 시각 동기화에 완전히 실패했습니다. 콘솔의 개별 샘플 에러를 확인하세요.');
	}

	samples.sort((a, b) => a.roundTripMs - b.roundTripMs);
	console.log(`[serverClock] 최종 채택 샘플:`, samples[0], `(전체 ${samples.length}개 성공)`);
	return samples[0].offsetMs;
}

let cachedOffsetMs = 0;
let isSynced = false;

export async function syncServerClock(sampleCount = 5): Promise<number> {
	cachedOffsetMs = await measureServerOffset(sampleCount);
	isSynced = true;
	return cachedOffsetMs;
}

export function serverNow(): number {
	if (!isSynced) {
		console.warn('[serverClock] syncServerClock()이 호출되기 전입니다. 로컬 시각을 그대로 반환합니다.');
	}
	return Date.now() + cachedOffsetMs;
}

export function getCurrentOffsetMs(): number {
	return cachedOffsetMs;
}

export function msUntilDeadline(deadline: string | Date): number {
	const deadlineMs = typeof deadline === 'string' ? new Date(deadline).getTime() : deadline.getTime();
	return deadlineMs - serverNow();
}
