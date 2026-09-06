// src/lib/roomPresence.ts
//
// Supabase Realtime Presence 기반 접속 상태 감지 + 서버 측 하트비트.
//
// Presence 채널은 "누가 지금 이 탭에 붙어 있는지"를 실시간으로 공유하는 용도로만 쓴다.
// 실제로 방/플레이어를 정리(호스트 위임, 참가자 제거, 방 삭제)하는 책임은
// 클라이언트가 아니라 서버(Postgres RPC + pg_cron)에 있다.
//
// 하트비트는 setInterval 만으로 보내면, 사용자가 탭을 백그라운드에 두거나
// 최소화했을 때 브라우저(특히 Chrome)가 비활성 탭의 타이머를 강하게 스로틀링해서
// 실제로는 접속 중인데도 서버가 이탈로 오판하는 문제가 있었다(대기실처럼
// 오래 가만히 떠 있는 화면에서 특히 자주 발생). 이를 막기 위해
// visibilitychange/focus 이벤트로 탭이 다시 활성화되는 순간 즉시 하트비트를
// 보내 공백을 메운다.
//
// 자동 방장 위임, 연결 끊김 상태 기록, 참가자 삭제는 이 모듈이 직접 수행하지 않는다.
// 방장 권한 변경은 대기실의 명시적 transfer_host RPC, 방장의 명시적 cancel_room RPC,
// 그리고 하트비트가 끊겼을 때 서버의 sweep_stale_rooms RPC만 수행한다.

import { supabase } from '$lib/supabaseClient';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface RoomPresenceHandle {
    channel: RealtimeChannel;
    stop: () => void;
}

const HEARTBEAT_INTERVAL_MS = 3000;

/**
 * 방(roomId)의 Presence 채널을 열고 현재 playerId를 등록한다.
 * 동시에 touch_player_heartbeat RPC를 주기적으로 호출해 서버에 생존을 알린다.
 *
 * getHostPlayerId 인자는 기존 호출부와의 호환성을 유지하기 위해 남겨 둔다.
 * 이 모듈은 자동 방장 위임을 수행하지 않으므로 값을 사용하지 않는다.
 */
export function joinRoomPresence(
    roomId: string,
    playerId: string,
    _getHostPlayerId: () => string | null
): RoomPresenceHandle {
    const channel = supabase.channel(`presence:room:${roomId}`, {
        config: { presence: { key: playerId } }
    });

    let isStopped = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    async function sendHeartbeat() {
        if (isStopped) return;
        const { error } = await supabase.rpc('touch_player_heartbeat', {
            p_player_id: playerId
        });
        if (error) {
            console.warn('[roomPresence] 하트비트 전송 실패:', error);
        }
    }

    function handleVisibilityOrFocus() {
        if (document.visibilityState === 'visible') {
            void sendHeartbeat();
        }
    }

    channel.subscribe(async (status) => {
        console.log(`[roomPresence] presence:room:${roomId} 채널 상태:`, status);

        if (status !== 'SUBSCRIBED' || isStopped) return;

        const { error } = await channel.track({
            player_id: playerId,
            online_at: new Date().toISOString()
        });

        if (error) {
            console.warn('[roomPresence] Presence 등록 실패:', error);
        }

        void sendHeartbeat();
        if (!heartbeatTimer) {
            heartbeatTimer = setInterval(() => void sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
        }

        document.addEventListener('visibilitychange', handleVisibilityOrFocus);
        window.addEventListener('focus', handleVisibilityOrFocus);
    });

    function stop() {
        if (isStopped) return;
        isStopped = true;
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
        window.removeEventListener('focus', handleVisibilityOrFocus);
        supabase.removeChannel(channel);
    }

    return { channel, stop };
}
