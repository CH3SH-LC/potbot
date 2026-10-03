package com.potbot.kernel.lifecycle;

/**
 * K-I21 —— {@code Clock} 端口的原生声明。
 *
 * <p>对应 {@code apps/mobile-kernel/lifecycle/types.ts} 的：
 * <pre>
 *   export interface Clock { now(): number; }
 * </pre>
 *
 * <p>契约：返回整数毫秒，与内核里所有 {@code *At} 字段**同单位同原点**（epoch 毫秒）。
 * 测试要能注入假时钟，故端口只暴露读取；生产实现见 {@link AndroidClock}。
 */
public interface Clock {

    /** 当前时间（epoch 毫秒）。 */
    long now();
}
