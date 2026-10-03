package com.potbot.kernel.lifecycle;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

/**
 * K-I21 —— ConnectivityManager 回调 → 内核网络状态。
 *
 * <p>对应 K10 {@code apps/mobile-kernel/lifecycle/network.ts} 的
 * {@code NetworkResumeController.setConnectivity('online' | 'offline')}：把系统连通性变化
 * 变成一次回调，供内核在断网时保存游标、恢复时从游标续跑。
 *
 * <p><b>fail-safe</b>：判不出"在线"时一律报 {@link LifecycleConstants#NETWORK_OFFLINE}，
 * 并以 {@code known=false} 如实标出"这是未知而非确证离线"。未知**绝不**触发续跑
 * （宁可等待，也不在可能断网时重发外部副作用）。
 *
 * <p><b>权限</b>：只用已声明的 {@code ACCESS_NETWORK_STATE}，**不新增**任何 uses-permission。
 *
 * <p><b>未验证</b>：未编译、未上真机。
 */
public final class ConnectivityObserver {

    /** 网络状态回调。{@code known=false} 表示判定不成立（未知），此时 {@code state} 为 offline。 */
    public interface Listener {
        void onNetworkStateChanged(String state, boolean known);
    }

    private final ConnectivityManager manager;
    private Listener listener;

    private final ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
        @Override
        public void onAvailable(Network network) {
            emit(LifecycleConstants.NETWORK_ONLINE, true);
        }

        @Override
        public void onLost(Network network) {
            emit(LifecycleConstants.NETWORK_OFFLINE, true);
        }

        @Override
        public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
            boolean online = capabilities != null
                    && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            emit(online ? LifecycleConstants.NETWORK_ONLINE : LifecycleConstants.NETWORK_OFFLINE, true);
        }

        @Override
        public void onUnavailable() {
            // 无法建立可用于判定的网络 ⇒ 未知；按 fail-safe 报 offline 且 known=false。
            emit(LifecycleConstants.NETWORK_OFFLINE, false);
        }
    };

    public ConnectivityObserver(Context context) {
        if (context == null) {
            throw new IllegalArgumentException("context 不能为空");
        }
        this.manager = (ConnectivityManager) context.getApplicationContext()
                .getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    /** 注册默认网络回调（API 24+）。重复注册前请先 {@link #stop()}。 */
    public void start(Listener listener) {
        if (listener == null) {
            throw new IllegalArgumentException("listener 不能为空");
        }
        this.listener = listener;
        if (manager != null) {
            manager.registerDefaultNetworkCallback(callback);
        } else {
            // 取不到系统服务 = 判不出 ⇒ 如实报未知离线，绝不假装在线。
            listener.onNetworkStateChanged(LifecycleConstants.NETWORK_OFFLINE, false);
        }
    }

    /** 注销回调（幂等；注销失败不抛，不掩盖主流程）。 */
    public void stop() {
        if (manager != null) {
            try {
                manager.unregisterNetworkCallback(callback);
            } catch (RuntimeException ignored) {
                // 未注册/已注销：忽略即可，不是错误。
            }
        }
        this.listener = null;
    }

    /**
     * 主动读取一次当前是否有 INTERNET 能力。
     * 判不出时返回 {@link LifecycleConstants#NETWORK_OFFLINE}（fail-safe，未知不当在线）。
     */
    public String currentState() {
        if (manager == null) {
            return LifecycleConstants.NETWORK_OFFLINE;
        }
        Network active = manager.getActiveNetwork();
        if (active == null) {
            return LifecycleConstants.NETWORK_OFFLINE;
        }
        NetworkCapabilities caps = manager.getNetworkCapabilities(active);
        boolean online = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        return online ? LifecycleConstants.NETWORK_ONLINE : LifecycleConstants.NETWORK_OFFLINE;
    }

    private void emit(String state, boolean known) {
        Listener current = listener;
        if (current != null) {
            current.onNetworkStateChanged(state, known);
        }
    }
}
