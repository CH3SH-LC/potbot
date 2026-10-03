package com.potbot.demo;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

/**
 * APP-06/APP-05：**网络切换的检测与断线状态**（合同 R253/R256/R258）。
 *
 * 只做两件事，且都只读：
 * <ul>
 *   <li>{@link #isOnline} 用 {@link ConnectivityManager} 判断当前**是否有可用的
 *       INTERNET 能力**；判不出来时返回 {@link Tri#UNKNOWN}，**不把未知当离线也不当在线**；</li>
 *   <li>{@link #register}/{@link #unregister} 监听默认网络变化（API 24+ 的
 *       {@code registerDefaultNetworkCallback}），把"网络切换"变成一次回调——
 *       宿主据此把 online/offline 如实报给页面（不假装已重连）。</li>
 * </ul>
 *
 * 权限：只用到已声明的 {@code ACCESS_NETWORK_STATE}，**不新增**任何权限。
 * 断线后的"续取/不重复执行"由 {@link PotbotTaskState} 的游标与幂等键负责，本类不重发任何动作。
 */
public final class PotbotConnectivity {

    /** 三态：绝不把"未知"折叠成"离线"或"在线"。 */
    public enum Tri {
        ONLINE, OFFLINE, UNKNOWN
    }

    /** 网络变化回调。 */
    public interface Listener {
        /**
         * @param online 当前是否有 INTERNET 能力（未知时为 false，并以 known=false 标出）
         * @param known  判定是否成立（false = 未知）
         */
        void onConnectivityChanged(boolean online, boolean known);
    }

    private PotbotConnectivity() {
    }

    /** 当前连通性三态。 */
    public static Tri isOnline(Context context) {
        if (context == null) {
            return Tri.UNKNOWN;
        }
        try {
            ConnectivityManager cm = (ConnectivityManager)
                    context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) {
                return Tri.UNKNOWN;
            }
            Network network = cm.getActiveNetwork();
            if (network == null) {
                return Tri.OFFLINE;
            }
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            if (caps == null) {
                return Tri.UNKNOWN;
            }
            if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                return Tri.ONLINE;
            }
            return Tri.OFFLINE;
        } catch (Throwable e) {
            return Tri.UNKNOWN;
        }
    }

    /**
     * 注册默认网络回调。返回手里持有的回调对象（供 {@link #unregister} 注销），
     * 注册失败返回 null（**调用方必须容忍 null**，不能把注册失败当在线）。
     */
    public static ConnectivityManager.NetworkCallback register(Context context, final Listener listener) {
        if (context == null || listener == null) {
            return null;
        }
        try {
            ConnectivityManager cm = (ConnectivityManager)
                    context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) {
                return null;
            }
            ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    listener.onConnectivityChanged(true, true);
                }

                @Override
                public void onLost(Network network) {
                    listener.onConnectivityChanged(false, true);
                }

                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                    boolean online = caps != null
                            && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
                    listener.onConnectivityChanged(online, true);
                }
            };
            cm.registerDefaultNetworkCallback(callback);
            return callback;
        } catch (Throwable e) {
            return null;
        }
    }

    /** 注销回调；参数为 null 时安全返回。 */
    public static void unregister(Context context, ConnectivityManager.NetworkCallback callback) {
        if (context == null || callback == null) {
            return;
        }
        try {
            ConnectivityManager cm = (ConnectivityManager)
                    context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                cm.unregisterNetworkCallback(callback);
            }
        } catch (Throwable e) {
            // 忽略：注销失败不影响正确性（宿主 onDestroy 时进程即将结束）。
        }
    }
}
