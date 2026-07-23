// =========================================================================
// Telegram Webhook 文件重复检测与管理系统备份核心逻辑 (V6 稳定版)
// =========================================================================

async function handleTelegramWebhook(req, res) {
    try {
        const update = req.body;
        const message = update?.message || update?.channel_post;

        // 非消息事件直接放行
        if (!message) {
            return res.status(200).send("OK");
        }

        const currentChatId = message.chat.id;
        const messageId = message.message_id;
        const chatTitle = message.chat.title || message.chat.first_name || "未知频道";

        // 提取文件唯一 ID 及元数据 (必须包含 uniqueId, mediaType, fileName, fileSizeFormatted)
        const mediaData = extractMediaData(message);
        if (!mediaData) {
            return res.status(200).send("OK"); // 非文件/媒体消息，忽略
        }

        const { uniqueId, mediaType, fileName, fileSizeFormatted } = mediaData;
        const redisKey = `file:${uniqueId}`;

        // =================================================================
        // 核心修改 1 & 2: Redis 查询、pending 状态拦截与统一 JSON 解析
        // =================================================================
        const recordRes = await redisCmd("get", redisKey);

        if (!recordRes.ok) {
            console.error("❌ Redis 查询异常，终止执行以保证安全性");
            return res.status(200).send("OK");
        }

        if (recordRes.result !== null) {
            let parsed = {};
            try {
                parsed = JSON.parse(recordRes.result);
            } catch (e) {
                console.error("❌ 解析 Redis 记录失败:", e);
            }

            // 1. 如果正在处理中 (pending)，说明另一个 Webhook 线程已抢到锁
            if (parsed.status === "pending") {
                console.log("⏳ 文件正在处理中，静默清理当前重复消息");
                await safeDeleteMessage(currentChatId, messageId);
                return res.status(200).send("OK");
            }

            // 2. 避免重复解析，直接提取 origin_message_id
            const originMsgId = parsed.origin_message_id;
            let isTargetStillAlive = false;

            // =============================================================
            // 核心修改 3: 探针检测与清理 (成功后立即删除探针产生的管理员副本)
            // =============================================================
            if (originMsgId) {
                const verify = await telegramFetch(
                    `${TELEGRAM_API}/copyMessage`,
                    {
                        method: "POST",
                        headers: JSON_HEADERS,
                        body: JSON.stringify({
                            chat_id: ADMIN_USER_ID,
                            from_chat_id: currentChatId,
                            message_id: originMsgId
                        })
                    }
                );

                if (verify.ok && verify.data?.ok) {
                    isTargetStillAlive = true;

                    // 探针验证成功，立即删掉发给管理员的这封探针消息，避免垃圾留存
                    await telegramFetch(
                        `${TELEGRAM_API}/deleteMessage`,
                        {
                            method: "POST",
                            headers: JSON_HEADERS,
                            body: JSON.stringify({
                                chat_id: ADMIN_USER_ID,
                                message_id: verify.data.result.message_id
                            })
                        }
                    );
                }
            }

            // =============================================================
            // 核心修改 4 & 5: 强制 await 管理系统备份，彻底消灭竞态条件
            // =============================================================
            if (isTargetStillAlive) {
                console.log(`♻️ 检测到存活的原消息 [${originMsgId}]，开始管理系统备份并清理重复消息`);

                // 强制同步等待 processDuplicateBackup 执行完成，绝不无 await 在后台跑
                await processDuplicateBackup(
                    chatTitle,
                    currentChatId,
                    messageId,
                    originMsgId,
                    {
                        mediaType,
                        fileName,
                        fileSizeFormatted
                    }
                );

                // 确保管理员接收/管理系统日志落地完毕后，再删频道里的重复消息
                await safeDeleteMessage(currentChatId, messageId);

                return res.status(200).send("OK");
            }

            // 原消息已失效/被删，清空/覆盖无效记录，继续向下当新文件处理
            console.log(`⚠️ 原始消息 [${originMsgId}] 已不在 Telegram，当作新文件重新建立记录`);
        }

        // =================================================================
        // 新文件处理流程：抢占 pending 锁
        // =================================================================
        const setLock = await redisCmd(
            "set",
            redisKey,
            JSON.stringify({ status: "pending" }),
            "NX",
            "EX",
            "60"
        );

        if (!setLock.ok || setLock.result !== "OK") {
            // 并发下未抢到锁，说明有其他请求先一步进入，直接当作重复消息清理
            console.log("⏳ 并发抢锁失败，清理当前重复消息");
            await safeDeleteMessage(currentChatId, messageId);
            return res.status(200).send("OK");
        }

        // =================================================================
        // 核心修改 6: 防重 skip 锁超时时长延长至 30 秒，适应大文件传输
        // =================================================================
        await redisCmd(
            "set",
            `skip:${uniqueId}`,
            "1",
            "EX",
            "30"
        );

        // -----------------------------------------------------------------
        // 此处接你原有的管理系统“新文件处理/转发/写入 Redis”完整逻辑...
        // -----------------------------------------------------------------
        /* Example:
        await processNewFileBackup(...);
        await redisCmd("set", redisKey, JSON.stringify({
            origin_chat_id: currentChatId,
            origin_message_id: messageId,
            status: "completed"
        }));
        */

        return res.status(200).send("OK");

    } catch (err) {
        console.error("❌ Webhook 核心逻辑异常:", err);
        return res.status(200).send("OK");
    }
}
