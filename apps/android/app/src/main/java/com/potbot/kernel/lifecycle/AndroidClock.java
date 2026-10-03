package com.potbot.kernel.lifecycle;

/**
 * K-I21 —— {@link Clock} 的生产实现（{@code System.currentTimeMillis()}）。
 *
 * <p>单位 epoch 毫秒、整数，与内核账本所有 {@code *At} 字段一致。测试请勿依赖本类：
 * 注入一个返回固定时刻的假 {@link Clock} 才能复现常驻预算与退避曲线。
 */
public final class AndroidClock implements Clock {

    /** 无状态，可共享实例。 */
    public static final AndroidClock INSTANCE = new AndroidClock();

    public AndroidClock() {
        // 无状态
    }

    @Override
    public long now() {
        return System.currentTimeMillis();
    }
}
