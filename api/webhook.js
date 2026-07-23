// =========================================================================
// Telegram Webhook 文件重复检测与备份核心逻辑 (V6 稳定测试版)
// =========================================================================

async function handleTelegramWebhook(req, res) {
    try {
        const update = req.body;
        const message = update?.message || update?.channel_post;

        if (!message) {
            return res.status(200).send("OK");
        }

        const currentChatId = message.chat.id;
        const messageId = message.message_id;
        const chatTitle = message.chat.title || message.chat.first_name || "未知频道";

        // 提取文件唯一 ID 及元数据 (假设包含 document, video, photo 等)
        const mediaData = extractMediaData(message);
        if (!mediaData) {
            return res.status(200).send("OK"); // 非媒体消息，忽略
        }

        const { uniqueId, mediaType, fileName, fileSizeFormatted } = mediaData;
        const redisKey = `file:${uniqueId}`;

        // -----------------------------------------------------------------
        // [修改一 & 修改二] 查询 Redis 记录，处理 pending 锁与 JSON 解析
        // -----------------------------------------------------------------
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

            // 1. 如果还在处理中（pending），说明已有 Webhook 抢到锁，直接清理当前重复消息
            if (parsed.status === "pending") {
                console.log("⏳ 文件正在处理中，清理当前重复消息");
                await safeDeleteMessage(currentChatId, messageId);
                return res.status(200).send("OK");
            }

            // 2. 复用 parsed 结构获取原始消息 ID
            const originMsgId = parsed.origin_message_id;

            // -------------------------------------------------------------
            // [修改三] 探针检测：判断原消息是否还在，并在成功后清理探针消息
            // -------------------------------------------------------------
            let isTargetStillAlive = false;

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

                    // 清理探针产生的临时消息，避免管理员收到垃圾消息
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

            // -------------------------------------------------------------
            // [修改四 & 修改五] 命中存活原消息，严格同步备份后再删频道重复消息
            // -------------------------------------------------------------
            if (isTargetStillAlive) {
                console.log(`♻️ 检测到存活的重复文件 [${uniqueId}]，开始备份并清理当前重复消息`);

                // 必须 await，彻底消除竞态条件
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

                // 备份完成后，再安全删除频道内的重复消息
                await safeDeleteMessage(currentChatId, messageId);

                return res.status(200).send("OK");
            }

            // 如果原消息已被删除 (isTargetStillAlive === false)，则继续向下走，重新抢锁并当作新文件处理
            console.log(`⚠️ 原消息 [${originMsgId}] 已不存在，准备重置记录并当作新文件处理`);
        }

        // -----------------------------------------------------------------
        // 新文件处理流程：抢占 pending 锁
        // -----------------------------------------------------------------
        const setLock = await redisCmd("set", redisKey, JSON.stringify({ status: "pending" }), "NX", "EX", "60");
        
        if (!setLock.ok || setLock.result !== "OK") {
            // 并发下抢锁失败，同样当作重复消息清理
            console.log("⏳ 并发抢锁失败，清理当前重复消息");
            await safeDeleteMessage(currentChatId, messageId);
            return res.status(200).send("OK");
        }

        // [修改六] 设置 skip 锁防重标志，过期时间调整为 30 秒
        await redisCmd("set", `skip:${uniqueId}`, "1", "EX", "30");

        // -----------------------------------------------------------------
        // 执行常规新消息备份/转发逻辑...
        // -----------------------------------------------------------------
        // 示例：更新 Redis 真实数据
        // await redisCmd("set", redisKey, JSON.stringify({
        //     origin_chat_id: currentChatId,
        //     origin_message_id: messageId,
        //     status: "completed"
        // }));

        return res.status(200).send("OK");

    } catch (err) {
        console.error("❌ Webhook 处理严重异常:", err);
        return res.status(200).send("OK");
    }
}
