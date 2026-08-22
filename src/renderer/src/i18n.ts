import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

export const LANGUAGE_KEY = 'ruanjian.language'
export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

const resources = {
  'zh-CN': {
    translation: {
      app: {
        name: '舒音', slogan: '让每个声音，都舒服入耳', ready: '引擎就绪',
        // Fixed bilingual pair (same value in both locale bundles) for
        // surfaces that show both languages together regardless of the
        // active UI language — see settings.about (Ticket 32 §5).
        nameZh: '舒音', nameEn: 'SootheVoice',
        sloganZh: '让每个声音，都舒服入耳', sloganEn: 'Every voice, soothing to the ear.',
      },
      language: { label: '语言', zh: '简体中文', en: 'English' },
      nav: { training: '模型训练', cover: '翻唱创作', audioTools: '音频工具', waveform: '波形编辑', playback: '播放/监听', subscription: '订阅' },
      common: {
        loading: '加载中…', cancel: '取消', retry: '重试', reset: '重置', refresh: '刷新',
        activate: '激活', deactivate: '停用', download: '下载', error: '错误', done: '完成',
        unavailable: '不可用',
      },
      updater: {
        ready: '更新已准备安装', install: '重启并安装', available: '发现更新 {{version}}',
        downloading: '正在下载…', download: '下载',
      },
      status: { running: '正在运行：{{method}}', idle: '引擎就绪', training: '训练中：{{mode}}', separating: '正在分离…', synthesizing: '正在合成（{{mode}}）…', saved: '已保存：{{path}}', applyingHighPitchProtection: '正在应用高音保护…', highPitchProtectionApplied: '已应用模型音域，高音保护起点为D#4', highPitchProtectionAppliedWithShift: '已应用模型音域，高音保护起点为D#4 | 建议{{direction}}{{count}}个调' },
      training: {
        title: '模型训练', description: '使用干声录音微调 AI 歌手的音色。', info: '模型信息', name: '模型名称 *', namePlaceholder: '例如：我的歌手', epochs: '训练轮数', material: '训练素材', noFiles: '未上传文件，将使用演示数据。', mode: '训练模式', start: '开始本地训练', training: '训练中…', complete: '✓ 训练完成', finalizing: '正在收尾…', finalizingDesc: '训练已完成，正在生成试听音频并保存模型。', audition: '试听', trainAnother: '训练另一个模型', models: '我的模型（{{count}}）', demo: '试听', retrain: '重新训练', delete: '删除', standard: '标准', professional: '专业', gpu: 'GPU', cpu: 'CPU', vram: '显存', epoch: '第 {{current}}/{{total}} 轮', loss: '损失 {{value}}', eta: '预计剩余 {{value}}', waiting: '等待引擎…', materialHint: '拖入干净的人声录音。', standardTagline: 'LoRA rank-4 · 仅训练音色编码器', professionalTagline: 'LoRA+ rank-8 · 全层训练 · 梯度检查点', dropAudio: '拖入音频文件，或点击浏览', audioFormats: 'WAV · FLAC · MP3 · OGG · M4A', fileCount: '{{count}} 个文件', totalDuration: '共 {{duration}}', clearAll: '全部清除', removeFile: '移除文件', loadingWaveform: '正在加载波形…', waveform: '波形', play: '播放', pause: '暂停', volume: '音量', noDemo: '暂无演示音频', lossLabel: '损失：{{value}}', pro: '专业', trainingGpu: 'GPU', trainingCpu: 'CPU', trainingVram: '显存', download: '下载模型', ready: '就绪', qualityLow: '音质较低',
      },
      cover: {
        title: '翻唱创作', description: '上传 → 分离 → 合成 → 混音 → 导出', upload: '上传并分离', song: '歌曲文件（WAV / FLAC / MP3）', chooseSong: '点击选择歌曲', separationMode: '分离模式', standard: '标准', enhanced: '增强', standardStems: '2 轨：人声 + 伴奏', enhancedStems: '3 轨：主唱 · 和声 · 伴奏', startSeparation: '开始分离', separating: '分离中…', stems: '音轨 — 点击独奏试听', nextModel: '下一步：选择模型 →', selectModel: '选择 AI 歌手模型', noModels: '还没有训练好的模型。请先前往模型训练。', algorithm: '翻唱算法', v1: 'V1 — 快速', v2: 'V2 — 高精度', v1Tagline: 'DTW + WSOLA · 实时率 ≤10%', v2Tagline: 'LSTM 表现力编码器 · 实时率 ≤50%', synthesize: '合成翻唱', synthesizing: '合成中…', nextSynthesize: '下一步：合成 →', mix: '合成与混音', mixer: '混音台', export: '下一步：导出 →', exportTitle: '导出音频',
        errUploadFirst: '请先上传一首歌曲。', errSelectModel: '请先选择模型。', errRunSeparation: '请先运行分离。',
        labelVocals: '人声', labelAccompaniment: '伴奏', labelLeadDry: '主唱（干声）', labelHarmonyDry: '和声（干声）',
        labelAiVocal: 'AI 人声', labelOrigHarmony: '原始和声', labelAccomp: '伴奏',
        stepUpload: '上传并分离', stepModel: '选择模型', stepMix: '合成与混音', stepExport: '导出',
        stemsLoading: '正在加载音轨…', unsolo: '取消独奏', mixerLoading: '正在加载音频音轨…', reverb: '混音', eqLow: '低音', eqMid: '中音', eqHigh: '高音',
        mixInfo: '模型：{{model}} · 算法：{{algo}}',
        synthesizedInfo: '✓ 翻唱合成完成，用时 {{elapsed}} 秒（音频时长 {{duration}} 秒）',
        // Ticket 44: Export Audio panel — was entirely hardcoded English.
        exportFormat: '格式', exportFormatWav: 'WAV（无损）', exportFormatFlac: 'FLAC（无损压缩）', exportFormatOgg: 'OGG Vorbis（有损压缩）',
        exportQuality: '音质 / 码率', exportAction: '导出音频', exportRendering: '正在渲染并导出…',
        exportResult: '已导出：{{path}}\n大小：{{size}} MB · 时长：{{duration}}',
        exportNeedsMix: '请先完成合成与混音步骤。',
        workflowSteps: '工作流程步骤',
        // Ticket 17: high-pitch protection (强制修音).
        highPitchProtection: '高音保护',
        highPitchProtectionThreshold: '高音保护起点为D#4',
        highPitchProtectionApply: '应用高音保护',
        highPitchProtectionApplying: '正在应用高音保护…',
        highPitchProtectionInfo: '已修正 {{count}} 处高音（约 {{percent}}% 时长）',
        highPitchProtectionLegend: '红色区域为强制修音修正范围',
        highPitchProtectionNone: '未检测到超出 D#4 的高音，无需修正。',
        // Ticket 22: recommended pitch shift, derived from the protected
        // vocal's re-analyzed range vs. the target song's original key.
        shiftDirectionDown: '降', shiftDirectionUp: '升',
        highPitchProtectionShiftSuggestion: '你的歌曲适合{{direction}}{{min}}个到{{max}}个调，建议{{direction}}{{rec}}个',
        // Ticket 18: Cloud Library (云曲库) integration.
        openLibrary: '☁️ 从云曲库选择', targetSongLabel: '当前目标歌曲：{{title}} - {{artist}}',
        clearTargetSong: '清除', unknownArtist: '未知艺术家',
        // Ticket 19: Pitch Shift / Tune slider.
        pitchShift: '调音（半音）', pitchShiftRecommended: '推荐移调：{{value}}',
        pitchShiftRecommendedTitle: '推荐移调：{{value}} 半音',
        pitchShiftApplyRecommended: '应用推荐值', pitchShiftProcessing: '正在处理移调音频…',
        // Ticket 20: Merge Audio & Upload Training Dataset (consumes Ticket
        // 17's 高音保护 and Ticket 19's 变调, both applied earlier in the
        // wizard — this step just reads their results).
        stepTrainingData: '训练数据集',
        trainingDataTitle: '生成训练数据集', trainingDataDesc: '合并已应用高音保护的人声与变调后的目标歌曲，打包上传并开始云端训练。',
        protectionTitle: '① 高音保护',
        protectionApplied: '✓ 已应用高音保护（强制修音）',
        protectionNeedsVocal: '请先完成合成与混音步骤，生成 AI 人声。',
        protectionNotApplied: '请先在③混音步骤中应用高音保护。',
        includeDryVocal: '同时包含干声人声轨（用于训练灵活性）',
        mergeTitle: '② 合并所有音频', mergeAction: '合并所有音频', merging: '合并中…',
        mergeBlockedTooltip: '请先完成：{{reasons}}',
        mergeBlockedShifting: '正在处理变调音频，请稍候…',
        prereqProtection: '高音保护', prereqTargetSong: '选择目标歌曲',
        mergeResultInfo: '✓ 已合并：时长 {{duration}} 秒 · {{sampleRate}} Hz',
        mergePadded: '（已用静音填充 {{sec}} 秒）', mergeTruncated: '（已截断 {{sec}} 秒）',
        uploadTitle: '③ 上传并开始训练', uploadAction: '上传并开始训练', uploadNeedsMerge: '请先合并所有音频。',
        phasePackaging: '正在打包…', phaseUploading: '正在上传…', phaseTraining: '云端训练中…',
        phaseDone: '✓ 训练已开始', uploadResult: '模型：{{modelUrl}}',
      },
      // Ticket 18: Cloud Library (云曲库) search modal.
      library: {
        title: '云曲库', close: '关闭', searchPlaceholder: '搜索歌曲或歌手',
        searching: '搜索中…', searchError: '搜索失败，请检查网络连接后重试',
        noResults: '未找到结果', emptyPrompt: '输入关键词开始搜索',
        select: '选择', downloading: '下载中…',
        prevPage: '上一页', nextPage: '下一页', pageOf: '第 {{page}} / {{totalPages}} 页',
      },
      audioTools: { title: '音频工具', description: '批量音源分离 — 拖入文件、选择模式、全部处理。', detect: '检测设备', drop: '拖入音频文件，或点击浏览', formats: '多个文件 · WAV · FLAC · OGG', files: '{{count}} 个文件', done: '{{count}} 个完成', pending: '{{count}} 个等待', failed: '{{count}} 个失败', process: '处理 {{count}} 个', processing: '处理中…', clear: '清空', pendingStatus: '● 等待中', errorStatus: '✕ 错误', downloadAll: '全部下载（{{count}}）', standard: '标准', enhanced: '增强' },
      // Ticket 16: pitch analysis ("分析音高") panel — waveform region selection
      // + max-note detection, shown after vocal separation in Cover Creation.
      pitch: {
        title: '音高分析', analyze: '分析音高', analyzing: '分析中…',
        selectRegionHint: '在波形上拖动以选择要分析的区域，不选择则自动分析整段音轨。',
        loadingWaveform: '正在加载波形…',
        wholeTrackLabel: '未选择区域 — 将分析整段音轨',
        regionSelected: '已选区域：{{start}}s – {{end}}s', clearRegion: '清除区域',
        wholeTrackTitle: '已分析整段音轨', wholeTrackMessage: '未选择区域，系统已自动分析整段音轨。',
        maxDetected: '检测到最高音', suggestedThreshold: '建议高音保护阈值', avgDetected: '平均音高',
        summary: '检测到最高音: {{maxNote}}, 建议高音保护阈值: {{thresholdNote}}',
        noPitchDetected: '未检测到有效音高，请确认所选区域包含人声。',
        // PATCH-02: 强制修音 触发按钮与波形阈值线可视化。
        applyProtection: '应用高音保护', applyingProtection: '正在应用…', protectionApplied: '已应用',
        applyProtectionHint: '请先分析音高',
        thresholdLineLabel: '{{note}}（高音保护线）',
        correctedLegend: '红色区域为超过 {{note}} 的强制修音范围',
        correctedInfo: '已修正 {{count}} 处高音（约 {{percent}}% 时长）',
        correctedNone: '未检测到超出 {{note}} 的高音，无需修正。',
        correctedRegionTitle: '已修正：{{start}}s – {{end}}s',
      },
      // Ticket 15: waveform display + drag-selected region editor.
      waveformEditor: {
        title: '波形编辑', description: '拖入音频文件查看波形，拖动鼠标选取片段用于后续处理。',
        drop: '拖入 WAV / MP3 文件，或点击浏览', formats: 'WAV · MP3',
        unsupportedFormat: '不支持的文件格式，请使用 WAV 或 MP3。',
        browse: '浏览…', pathPlaceholder: '点击"浏览"选择音频文件（WAV / MP3 / FLAC / AAC）',
        play: '播放', pause: '暂停', stop: '停止',
        loopSelection: '循环播放选区', clearSelection: '清除选区',
        selectionInfo: '选区：{{start}} – {{end}}（时长 {{dur}}）',
      },
      // Automatic lyrics recognition status copy (Ticket 43 §6) — shown in the
      // Playback/Monitor lyrics panel while/after an automatic online match runs.
      lyrics: {
        auto: {
          searching: '正在搜索歌词…',
          found: '歌词已自动加载。',
          notfound: '未自动找到歌词，您可以导入 LRC 文件或手动搜索。',
        },
      },
      // Ticket 46: shared stem-name labels for track lists that render raw
      // separation-engine identifiers (accompaniment/vocals/lead_dry/
      // harmony_dry) — see utils/stems.ts's stemLabelKey().
      tracks: { vocal: '人声', accompaniment: '伴奏', harmony: '和声', other: '其他' },
      playback: { title: '播放/监听', description: '加载音频、分离音轨、对比原唱与 AI 翻唱，并实时录制人声。', trackList: '音轨列表', loadOriginal: '加载原始音频', loadCover: '加载 AI 翻唱', noTracks: '暂无音轨 — 加载音频文件开始。', separate: '分离音轨', separating: '分离中…', separateMode: '分离模式', standard: '标准', enhanced: '增强', mute: '静音', solo: '独奏', volume: '音量', remove: '移除', waveform: '波形显示', zoomIn: '放大', zoomOut: '缩小', play: '播放', pause: '暂停', stop: '停止', abTitle: 'A/B 对比', trackA: '音轨 A', trackB: '音轨 B', switchAB: '切换 A/B', autoAlign: '自动对齐', aligning: '对齐中…', aligned: '已对齐（偏移 {{offset}} 秒）', selectTwoTracks: '请选择两条音轨进行对比', recordingPanel: '实时录音', record: '● 录音', recording: '● 正在录音…', stopRecording: '停止录音', save: '保存录音', discard: '丢弃', micUnavailable: '无法访问麦克风', recordedClip: '录音片段', original: '原始混音', stem: '分离音轨', cover: 'AI 翻唱', clip: '录音', lyrics: '歌词', expand: '展开', collapse: '收起', importLrc: '导入 LRC', searchOnline: '在线搜索', subscribeForSearch: '订阅后可使用在线歌词搜索', noLyrics: '暂无歌词，请导入 .lrc 文件或在线搜索', searchLyricsTitle: '在线搜索歌词', searchQueryPlaceholder: '歌曲名称', searchArtistPlaceholder: '艺术家（可选）', search: '搜索', searching: '搜索中…', searchNoResults: '未找到结果', searchError: '搜索失败，请检查网络连接后重试', useResult: '使用', unsynced: '无时间轴', instrumental: '纯音乐', closeSearch: '关闭', songs: '歌曲列表', addSong: '添加歌曲', noSongs: '暂无歌曲 — 点击上方按钮或将音频文件拖入此处。', noSongSelected: '未选择歌曲', trackCount: '{{count}} 轨', hideSongs: '隐藏歌曲列表', showSongs: '显示歌曲列表', filterSongs: '搜索歌曲或艺术家', sortBy: '排序', sortTitle: '标题', sortArtist: '艺术家', sortDateAdded: '添加时间', ctxPlay: '播放', ctxRemove: '从列表移除', ctxShowInFolder: '在文件夹中显示', like: '喜欢', unlike: '取消喜欢', share: '分享', shareCopied: '已复制到剪贴板', enterFullscreen: '全屏歌词', exitFullscreen: '退出全屏', unknownArtist: '未知艺术家', dragResize: '拖动调整高度', nowPlaying: '正在播放', monitoring: '波形与监听' },
      subscription: { title: '订阅', description: '管理舒音许可证和订阅计划。', status: '许可证状态', plan: '计划', trial: '试用', validUntil: '有效期至', daysRemaining: '剩余天数', features: '授权功能', active: '✓ 已激活', unlicensed: '○ 未授权', expired: '✕ 已过期', grace: '⚠ 已过期（宽限期）', graceMessage: '订阅已过期，剩余 {{count}} 天宽限期。', invalid: '✕ 无效令牌', manage: '管理订阅', renew: '续订', activateTitle: '激活许可证', renewTitle: '续订订阅', enterKey: '输入许可证密钥以解锁全部功能。', expiredDesc: '订阅已过期。续订后恢复完整访问。', subscribe: '订阅', subscribeNow: '立即订阅', activateKey: '输入现有许可证密钥', keyPlaceholder: 'SOOTHEVOICE-XXXX-XXXX-XXXX', activating: '激活中…', subscribeUnlock: '订阅解锁', lockDescription: '舒音需要有效订阅才能使用 AI 功能。现在开始 30 天免费试用。', haveKey: '已有许可证密钥？请前往订阅页面。', expiredTitle: '订阅已过期', expiredLockDesc: '您的订阅已失效。续订后恢复全部功能。', openCheckout: '打开支付页面',
        choosePlan: '选择计划', choosePayment: '选择支付方式', payNow: '立即支付',
        // Ticket 34: multi-period plan cards.
        plans: { monthly: '月付', quarterly: '季付', semi_annual: '半年付', annual: '年付', trial: '试用' },
        planDesc: {
          monthly: '按月计费', quarterly: '每 3 个月计费一次',
          semi_annual: '每 6 个月计费一次', annual: '按年计费，最省钱',
        },
        discountBadge: '优惠 {{percent}}%', bestValue: '最划算',
        periodMonths: '{{count}} 个月',
        chargeSummary: '将向你收取 {{amount}}，服务时长 {{period}}。',
        plansLoading: '正在加载订阅计划…',
        plansUnavailable: '订阅计划暂时不可用，请稍后重试。',
        method: { wechat_pay: '微信支付', alipay: '支付宝', douyin_pay: '抖音支付', card: '银行卡' },
        payWith: '使用{{method}}支付', methodsLoading: '正在加载支付方式…',
        methodsUnavailable: '支付方式暂时不可用，请稍后重试。',
        creatingOrder: '正在创建订单…', waitingPayment: '等待支付完成…',
        waitingWechat: '请在打开的窗口中使用微信扫码支付。', waitingDouyin: '请在打开的窗口中使用抖音扫码支付。',
        waitingAlipay: '请在打开的浏览器窗口中完成支付宝支付。', waitingCard: '请在打开的浏览器窗口中完成银行卡支付。',
        cancelPayment: '取消支付', paymentSuccess: '✓ 支付成功，订阅已更新！', paymentFailed: '支付失败或已取消。',
        paymentTimeout: '支付等待超时，请重试，或稍后在支付历史中查看订单状态。', tryAgain: '重试',
        paymentWindowClosed: '支付窗口已关闭，且未检测到成功支付。如已完成支付，请稍后在支付历史中查看订单状态。',
        historyTitle: '支付历史', historyEmpty: '暂无支付记录。', historyDate: '日期', historyPlan: '计划',
        historyMethod: '支付方式', historyAmount: '金额', historyStatus: '状态',
        orderStatus: { pending: '待支付', paid: '已支付', failed: '失败', expired: '已过期' },
      },
      trial: {
        expiredTitle: '试用已结束',
        banner: {
          remaining: '试用剩余：{{days}} 天',
          remainingHours: '试用剩余：{{hours}} 小时',
          subscribe: '立即订阅',
        },
        subscription: {
          active: '您的免费试用还剩 {{days}} 天，订阅以继续使用。',
          expired: '您的免费试用已结束，请选择套餐继续使用。',
        },
      },
      onboarding: { welcome: '欢迎使用舒音', welcomeDesc: 'AI 歌手翻唱软件，帮助你训练歌手模型、制作翻唱并处理音频。', modelTitle: '模型训练', modelDesc: '在模型训练页面上传干声素材，创建属于你的 AI 歌手模型。', coverTitle: '翻唱创作', coverDesc: '上传歌曲，分离人声与伴奏，再选择模型替换原唱。', toolsTitle: '音频工具', toolsDesc: '使用批量音源分离工具快速提取人声、和声与伴奏。', next: '下一步', skip: '跳过', getStarted: '开始使用', progress: '{{current}} / {{total}}', showAgain: '再次查看使用教程', dontShow: '不再显示',
        start: '开始使用 →', hardware: '检测硬件', scanning: '正在扫描 GPU 加速…', continue: '继续 →', warmup: '模型预热', warmupDesc: '预加载推理引擎，让第一次合成更快。', warmupRunning: '正在初始化 AI 引擎…', warmupSuccess: '✓ 引擎已就绪，可以开始使用。', warmupContinue: '继续', warmupSkip: '跳过预热', runWarmup: '运行预热', ready: '✓ 引擎就绪', warmupFailed: '预热失败，将以降级模式继续。', retryWarmup: '重试预热', allSet: '准备完成！', allSetDesc: '舒音已配置完成，可以开始使用。', open: '打开舒音' },
      errors: { verificationUrl: '许可证验证服务未配置。', checkoutUrl: '支付页面未配置。', engine: '引擎错误：{{message}}', generic: '发生错误：{{message}}' },
      // Ticket 35: in-app notification system — toast banners + notification
      // center. Title/message pairs, one per trigger event (see
      // useNotificationStore.ts's NotifyInput.titleKey/messageKey).
      notification: {
        center: { title: '通知', empty: '暂无通知', markAllRead: '全部标为已读', clearAll: '清空' },
        training: {
          complete: { title: '训练完成', message: '模型“{{modelName}}”已准备好使用。' },
          failed:   { title: '训练失败', message: '训练未能完成：{{message}}' },
          downloaded: { title: '模型已下载', message: '模型“{{modelName}}”已加密并保存。' },
          downloadFailed: { title: '模型下载失败', message: '下载未能完成：{{message}}' },
        },
        separation: {
          complete: { title: '分离完成', message: '音轨分离已完成（{{mode}}）。' },
          failed:   { title: '分离失败', message: '音轨分离未能完成：{{message}}' },
        },
        separationBatch: {
          complete: { title: '批量分离完成', message: '{{count}} 个文件已处理完成。' },
          failed:   { title: '部分分离失败', message: '{{count}} 个文件处理失败。' },
        },
        synthesis: {
          complete: { title: '合成完成', message: '翻唱合成已完成（{{mode}}）。' },
          failed:   { title: '合成失败', message: '翻唱合成未能完成：{{message}}' },
        },
        highPitchProtection: {
          complete: { title: '高音保护已应用', message: '已修正 {{count}} 处高音，高音保护起点为 D#4。' },
          failed:   { title: '高音保护失败', message: '高音保护未能完成：{{message}}' },
        },
        trainUpload: {
          complete: { title: '训练已开始', message: '训练数据集已上传，云端训练任务已开始。' },
          failed:   { title: '上传/训练失败', message: '未能上传训练数据集或启动训练：{{message}}' },
        },
        trial: {
          activated:     { title: '试用已激活', message: '你的免费试用已开始，尽情体验全部功能吧。' },
          expiringSoon:  { title: '试用即将到期', message: '试用剩余 {{hours}} 小时，订阅以继续使用。' },
          expired:       { title: '试用已结束', message: '免费试用已结束，请选择套餐继续使用。' },
        },
        payment: {
          success: { title: '支付成功', message: '订阅已更新，全部功能已解锁。' },
        },
        subscription: {
          expiringSoon: { title: '订阅即将到期', message: '你的订阅将在 {{days}} 天后到期，请及时续订。' },
          expired:      { title: '订阅已过期', message: '订阅已过期，部分功能可能受限，请续订以恢复完整访问。' },
        },
        system: {
          updateAvailable: { title: '发现新版本', message: '版本 {{version}} 可供下载。' },
          updateReady:     { title: '更新已就绪', message: '重启应用以完成安装。' },
          // Ticket 37 §1/§4: "Update Check Failed" no longer fires as a
          // notification — failures surface only inline in Settings → Updates.
          welcome:         { title: '欢迎使用舒音', message: '从模型训练开始，创建属于你的 AI 歌手吧。' },
          licenseGrace:    { title: '许可证验证异常', message: '暂时无法验证订阅状态，已进入宽限期，请检查网络连接。' },
          rendererRecovered: { title: '应用已恢复', message: '界面从异常中恢复，如仍有问题请重启应用。' },
        },
        custom: {
          bgUploadFailed: { title: '背景图片上传失败', message: '请更换图片后重试。' },
        },
      },
      settings: {
        title: '设置', description: '自定义外观模式、字体、主题色彩、背景图片，并上传你的个人头像。',
        appearance: '外观模式', system: '跟随系统', light: '浅色', dark: '深色',
        font: '字体', fontFamily: { system: '系统默认', sans: '无衬线', serif: '衬线', mono: '等宽' },
        fontSize: '字号', fontSizePreview: '预览：字号会实时应用到整个界面。', fontSizePreviewSub: '包括歌词面板与波形时间标签。',
        themeColor: '主题色彩',
        accentLabel: '强调色',
        accent: {
          indigo: '靛蓝', blue: '天蓝', teal: '青绿', green: '翠绿', orange: '橙色', pink: '粉色', red: '红色', violet: '紫罗兰',
          netease: '网易红', spotify: 'Spotify 绿', applemusic: 'Apple Music 粉', youtube: 'YouTube 红', skyblue: '天空蓝',
        },
        customColor: '自定义颜色', customColorHint: '选择任意颜色作为主题色，悬停/按下状态将自动生成。',
        previewButton: '主要按钮', previewTab: '当前标签', previewLyric: '当前歌词',
        contrastRatio: '对比度 {{ratio}}:1',
        background: '背景图片', uploadBackground: '上传背景图片', removeBackground: '移除背景图片',
        backgroundHint: '图片会自动模糊并叠加深色遮罩，作为整个应用的背景。建议小于 10MB。',
        bgTooLarge: '图片过大，请选择小于 10MB 的图片。', bgInvalid: '无法读取该图片，请换一张重试。',
        bgUpdated: '背景已更新', bgMissing: '背景图片文件缺失，已恢复默认背景，请重新上传。',
        bgBlurIntensity: '模糊强度', bgOverlayOpacity: '遮罩不透明度',
        bgBrightWarning: '检测到图片较亮，已自动提高遮罩不透明度以保证文字清晰，你也可以在下方手动调整。',
        profilePhoto: '个人头像', uploadPhoto: '上传照片', removePhoto: '移除照片',
        photoHint: '建议使用正方形图片，将自动裁剪并压缩为头像。', photoInvalid: '无法读取该图片，请换一张重试。',
        about: {
          title: '关于', version: '版本 {{version}}', developer: '开发者', developerName: 'SootheVoice 团队',
        },
        // Ticket 37: manual "Check for Updates" moved here from the
        // automatic-only flow — see settings.updates in TopToolbar's
        // updater.* keys above for the toolbar-side download/install copy.
        updates: {
          title: '更新', checkButton: '检查更新', checking: '正在检查…',
          upToDate: '当前已是最新版本。', newVersion: '发现新版本 {{version}}。',
          updateNow: '立即更新', failed: '检查更新失败，请稍后重试。',
        },
        notifications: {
          title: '通知', description: '管理任务、订阅与系统通知的显示方式。', categories: '通知类别',
          category: {
            taskCompletion: '任务完成', taskFailure: '任务失败', subscription: '订阅与试用',
            system: '系统消息', custom: '其他提醒',
          },
          duration: '显示时长', position: '显示位置', positionTopRight: '右上角', positionBottomRight: '右下角',
        },
        lyrics: {
          title: '歌词', description: '控制加载歌曲时是否自动在线匹配歌词。',
          autoFetch: '自动获取歌词',
          autoFetchHint: '加载歌曲且本地未找到歌词时，自动从在线歌词库匹配并加载同步歌词。',
        },
      },
    },
  },
  'en-US': {
    translation: {
      app: {
        name: 'SootheVoice', slogan: 'Every voice, soothing to the ear.', ready: 'Engine ready',
        nameZh: '舒音', nameEn: 'SootheVoice',
        sloganZh: '让每个声音，都舒服入耳', sloganEn: 'Every voice, soothing to the ear.',
      },
      language: { label: 'Language', zh: '简体中文', en: 'English' },
      nav: { training: 'Model Training', cover: 'Cover Creation', audioTools: 'Audio Tools', waveform: 'Waveform Editor', playback: 'Playback / Monitor', subscription: 'Subscription' },
      common: { loading: 'Loading…', cancel: 'Cancel', retry: 'Retry', reset: 'Reset', refresh: 'Refresh', activate: 'Activate', deactivate: 'Deactivate', download: 'Download', error: 'Error', done: 'Done', unavailable: 'Unavailable' },
      updater: { ready: 'Update ready to install', install: 'Restart & Install', available: 'Update {{version}} available', downloading: 'Downloading…', download: 'Download' },
      status: { running: 'Running: {{method}}', idle: 'Engine ready', training: 'Training: {{mode}}', separating: 'Separating…', synthesizing: 'Synthesizing ({{mode}})…', saved: 'Saved: {{path}}', applyingHighPitchProtection: 'Applying high-pitch protection…', highPitchProtectionApplied: 'Model vocal range applied — high-pitch protection starts at D#4', highPitchProtectionAppliedWithShift: 'Model vocal range applied — high-pitch protection starts at D#4 | Recommended: shift {{direction}} by {{count}} semitone(s)' },
      training: { title: 'Model Training', description: 'Fine-tune the AI singer\'s timbre using dry vocal recordings.', info: 'Model Info', name: 'Model name *', namePlaceholder: 'e.g. My Singer', epochs: 'Epochs', material: 'Training Material', noFiles: 'No files uploaded; synthetic demo data will be used.', mode: 'Training Mode', start: 'Start Local Training', training: 'Training…', complete: '✓ Training Complete', finalizing: 'Finalizing…', finalizingDesc: 'Training finished. Generating the demo clip and saving the model.', audition: 'Audition', trainAnother: 'Train Another Model', models: 'Your Models ({{count}})', demo: 'Demo', retrain: 'Retrain', delete: 'Delete', standard: 'Standard', professional: 'Professional', gpu: 'GPU', cpu: 'CPU', vram: 'VRAM', epoch: 'Epoch {{current}}/{{total}}', loss: 'Loss {{value}}', eta: 'ETA {{value}}', waiting: 'Waiting for engine…', materialHint: 'Drop clean vocal recordings here.', standardTagline: 'LoRA rank-4 · timbre encoder only', professionalTagline: 'LoRA+ rank-8 · all layers · gradient checkpointing', dropAudio: 'Drop audio files here, or click to browse', audioFormats: 'WAV · FLAC · MP3 · OGG · M4A', fileCount: '{{count}} file(s)', totalDuration: '{{duration}} total', clearAll: 'Clear all', removeFile: 'Remove file', loadingWaveform: 'Loading waveform…', waveform: 'waveform', play: 'Play', pause: 'Pause', volume: 'Volume', noDemo: 'No demo available', lossLabel: 'Loss: {{value}}', pro: 'Pro', trainingGpu: 'GPU', trainingCpu: 'CPU', trainingVram: 'VRAM', download: 'Download Model', ready: 'Ready', qualityLow: 'Quality may be low' },
      cover: { title: 'Cover Creation', description: 'Upload → Separate → Synthesize → Mix → Export', upload: 'Upload & Separate', song: 'Song file (WAV / FLAC / MP3)', chooseSong: 'Click to choose a song', separationMode: 'Separation mode', standard: 'Standard', enhanced: 'Enhanced', standardStems: '2 stems — vocals + accompaniment', enhancedStems: '3 stems — lead · harmony · accompaniment', startSeparation: 'Start Separation', separating: 'Separating…', stems: 'Stems — click Solo to preview', nextModel: 'Next: Select Model →', selectModel: 'Select AI Singer Model', noModels: 'No models trained yet. Go to Model Training first.', algorithm: 'Cover algorithm', v1: 'V1 — Fast', v2: 'V2 — High-Precision', v1Tagline: 'DTW + WSOLA · ≤10% real-time', v2Tagline: 'LSTM expression encoder · ≤50% RT', synthesize: 'Synthesize Cover', synthesizing: 'Synthesizing…', nextSynthesize: 'Next: Synthesize →', mix: 'Synthesize & Mix', mixer: 'Mixing Console', export: 'Next: Export →', exportTitle: 'Export Audio',
        errUploadFirst: 'Please upload a song first.', errSelectModel: 'Select a model first.', errRunSeparation: 'Run separation first.',
        labelVocals: 'Vocals', labelAccompaniment: 'Accompaniment', labelLeadDry: 'Lead (dry)', labelHarmonyDry: 'Harmony (dry)',
        labelAiVocal: 'AI Vocal', labelOrigHarmony: 'Orig. Harmony', labelAccomp: 'Accomp.',
        stepUpload: 'Upload & Separate', stepModel: 'Select Model', stepMix: 'Synthesize & Mix', stepExport: 'Export',
        stemsLoading: 'Loading stems…', unsolo: 'Un-solo', mixerLoading: 'Loading audio tracks…', reverb: 'Reverb', eqLow: 'Lo', eqMid: 'Mid', eqHigh: 'Hi',
        mixInfo: 'Model: {{model}} · Algorithm: {{algo}}',
        synthesizedInfo: '✓ Cover synthesized in {{elapsed}}s ({{duration}}s audio)',
        // Ticket 44: Export Audio panel — was entirely hardcoded English.
        exportFormat: 'Format', exportFormatWav: 'WAV (lossless)', exportFormatFlac: 'FLAC (lossless compressed)', exportFormatOgg: 'OGG Vorbis (lossy)',
        exportQuality: 'Quality / Bitrate', exportAction: 'Export Audio', exportRendering: 'Rendering & exporting…',
        exportResult: 'Exported: {{path}}\nSize: {{size}} MB · Duration: {{duration}}',
        exportNeedsMix: 'Complete the mixing step first.',
        workflowSteps: 'Workflow steps',
        // Ticket 17: high-pitch protection (forced auto-tune / 强制修音).
        highPitchProtection: 'High-Pitch Protection',
        highPitchProtectionThreshold: 'High-pitch protection starts at D#4',
        highPitchProtectionApply: 'Apply High-Pitch Protection',
        highPitchProtectionApplying: 'Applying high-pitch protection…',
        highPitchProtectionInfo: 'Corrected {{count}} high-pitch region(s) (~{{percent}}% of duration)',
        highPitchProtectionLegend: 'Red regions were corrected by forced auto-tune',
        highPitchProtectionNone: 'No pitch above D#4 detected — nothing to correct.',
        // Ticket 22: recommended pitch shift, derived from the protected
        // vocal's re-analyzed range vs. the target song's original key.
        shiftDirectionDown: 'down', shiftDirectionUp: 'up',
        highPitchProtectionShiftSuggestion: 'Your song suits a shift {{direction}} of {{min}}–{{max}} semitones — we recommend {{rec}}.',
        // Ticket 18: Cloud Library integration.
        openLibrary: '☁️ Choose from Cloud Library', targetSongLabel: 'Target song: {{title}} - {{artist}}',
        clearTargetSong: 'Clear', unknownArtist: 'Unknown Artist',
        // Ticket 19: Pitch Shift / Tune slider.
        pitchShift: 'Tune (semitones)', pitchShiftRecommended: 'Recommended shift: {{value}}',
        pitchShiftRecommendedTitle: 'Recommended shift: {{value}} semitones',
        pitchShiftApplyRecommended: 'Apply recommended', pitchShiftProcessing: 'Re-processing shifted audio…',
        // Ticket 20: Merge Audio & Upload Training Dataset (consumes Ticket
        // 17's high-pitch protection and Ticket 19's pitch shift, both
        // applied earlier in the wizard — this step just reads their results).
        stepTrainingData: 'Training Dataset',
        trainingDataTitle: 'Build Training Dataset', trainingDataDesc: 'Merge the high-pitch-protected vocal with the pitch-shifted target song, then package and upload it to start cloud training.',
        protectionTitle: '① High-Pitch Protection',
        protectionApplied: '✓ High-pitch protection applied (forced auto-tune)',
        protectionNeedsVocal: 'Complete the synthesize & mix step first to generate an AI vocal.',
        protectionNotApplied: 'Apply high-pitch protection in step ③ (Mix) first.',
        includeDryVocal: 'Also include the dry vocal track (for training flexibility)',
        mergeTitle: '② Merge All Audio', mergeAction: 'Merge All Audio', merging: 'Merging…',
        mergeBlockedTooltip: 'Complete first: {{reasons}}',
        mergeBlockedShifting: 'Pitch-shift processing in progress — please wait…',
        prereqProtection: 'high-pitch protection', prereqTargetSong: 'target song selection',
        mergeResultInfo: '✓ Merged: {{duration}}s · {{sampleRate}} Hz',
        mergePadded: ' (padded with {{sec}}s of silence)', mergeTruncated: ' (truncated {{sec}}s)',
        uploadTitle: '③ Upload & Start Training', uploadAction: 'Upload & Start Training', uploadNeedsMerge: 'Merge all audio first.',
        phasePackaging: 'Packaging…', phaseUploading: 'Uploading…', phaseTraining: 'Training in the cloud…',
        phaseDone: '✓ Training started', uploadResult: 'Model: {{modelUrl}}',
      },
      // Ticket 18: Cloud Library search modal.
      library: {
        title: 'Cloud Library', close: 'Close', searchPlaceholder: 'Search songs or artists',
        searching: 'Searching…', searchError: 'Search failed — check your connection and try again',
        noResults: 'No results found', emptyPrompt: 'Type a keyword to start searching',
        select: 'Select', downloading: 'Downloading…',
        prevPage: 'Prev', nextPage: 'Next', pageOf: 'Page {{page}} of {{totalPages}}',
      },
      audioTools: { title: 'Audio Tools', description: 'Batch source separation — drop files, choose modes, process all.', detect: 'Detect Device', drop: 'Drop audio files here, or click to browse', formats: 'Multiple files · WAV · FLAC · OGG', files: '{{count}} file(s)', done: '{{count}} done', pending: '{{count}} pending', failed: '{{count}} failed', process: 'Process {{count}}', processing: 'Processing…', clear: 'Clear', pendingStatus: '● Pending', errorStatus: '✕ Error', downloadAll: 'Download All ({{count}})', standard: 'Standard', enhanced: 'Enhanced' },
      // Ticket 16: pitch analysis ("Analyze Pitch") panel — waveform region
      // selection + max-note detection, shown after vocal separation in Cover Creation.
      pitch: {
        title: 'Pitch Analysis', analyze: 'Analyze Pitch', analyzing: 'Analyzing…',
        selectRegionHint: 'Drag on the waveform to select a region to analyze, or leave it unselected to analyze the whole track.',
        loadingWaveform: 'Loading waveform…',
        wholeTrackLabel: 'No region selected — the whole track will be analyzed',
        regionSelected: 'Selected region: {{start}}s – {{end}}s', clearRegion: 'Clear region',
        wholeTrackTitle: 'Analyzed whole track', wholeTrackMessage: 'No region was selected, so the entire track was analyzed automatically.',
        maxDetected: 'Detected highest note', suggestedThreshold: 'Suggested high-note protection threshold', avgDetected: 'Average pitch',
        summary: 'Detected highest note: {{maxNote}}, suggested high-note protection threshold: {{thresholdNote}}',
        noPitchDetected: 'No pitch detected — make sure the selected region contains vocals.',
        // PATCH-02: forced auto-tune trigger + waveform threshold-line overlay.
        applyProtection: 'Apply High-Pitch Protection', applyingProtection: 'Applying…', protectionApplied: 'Applied',
        applyProtectionHint: 'Analyze the pitch first',
        thresholdLineLabel: '{{note}} (protection threshold)',
        correctedLegend: 'Red spans were clamped back down from above {{note}}',
        correctedInfo: 'Corrected {{count}} high-pitch region(s) (~{{percent}}% of duration)',
        correctedNone: 'No pitch above {{note}} detected — nothing to correct.',
        correctedRegionTitle: 'Corrected: {{start}}s – {{end}}s',
      },
      // Ticket 15: waveform display + drag-selected region editor.
      waveformEditor: {
        title: 'Waveform Editor', description: 'Drop an audio file to view its waveform, then drag on it to select a region for downstream processing.',
        drop: 'Drop a WAV / MP3 file here, or click to browse', formats: 'WAV · MP3',
        unsupportedFormat: 'Unsupported file format — please use WAV or MP3.',
        browse: 'Browse…', pathPlaceholder: 'Click "Browse" to choose an audio file (WAV / MP3 / FLAC / AAC)',
        play: 'Play', pause: 'Pause', stop: 'Stop',
        loopSelection: 'Loop selection', clearSelection: 'Clear selection',
        selectionInfo: 'Selection: {{start}} – {{end}} ({{dur}})',
      },
      lyrics: {
        auto: {
          searching: 'Searching lyrics…',
          found: 'Lyrics loaded automatically.',
          notfound: 'No lyrics found automatically. You can import an LRC file or search manually.',
        },
      },
      // Ticket 46: shared stem-name labels for track lists that render raw
      // separation-engine identifiers (accompaniment/vocals/lead_dry/
      // harmony_dry) — see utils/stems.ts's stemLabelKey().
      tracks: { vocal: 'Vocal', accompaniment: 'Accompaniment', harmony: 'Harmony', other: 'Other' },
      playback: { title: 'Playback / Monitor', description: 'Load audio, separate stems, A/B compare the original vocal against an AI cover, and record your voice live.', trackList: 'Track List', loadOriginal: 'Load Original Audio', loadCover: 'Load AI Cover', noTracks: 'No tracks yet — load an audio file to get started.', separate: 'Separate', separating: 'Separating…', separateMode: 'Separation mode', standard: 'Standard', enhanced: 'Enhanced', mute: 'Mute', solo: 'Solo', volume: 'Volume', remove: 'Remove', waveform: 'Waveform', zoomIn: 'Zoom in', zoomOut: 'Zoom out', play: 'Play', pause: 'Pause', stop: 'Stop', abTitle: 'A/B Comparison', trackA: 'Track A', trackB: 'Track B', switchAB: 'Switch A/B', autoAlign: 'Auto-Align', aligning: 'Aligning…', aligned: 'Aligned (offset {{offset}}s)', selectTwoTracks: 'Select two tracks to compare', recordingPanel: 'Live Recording', record: '● Record', recording: '● Recording…', stopRecording: 'Stop Recording', save: 'Save Recording', discard: 'Discard', micUnavailable: 'Microphone unavailable', recordedClip: 'Recorded clip', original: 'Original Mix', stem: 'Stem', cover: 'AI Cover', clip: 'Recording', lyrics: 'Lyrics', expand: 'Expand', collapse: 'Collapse', importLrc: 'Import LRC', searchOnline: 'Search Online', subscribeForSearch: 'Subscribe to use online lyrics search', noLyrics: 'No lyrics — import a .lrc file or search online', searchLyricsTitle: 'Search Lyrics Online', searchQueryPlaceholder: 'Song title', searchArtistPlaceholder: 'Artist (optional)', search: 'Search', searching: 'Searching…', searchNoResults: 'No results found', searchError: 'Search failed — check your connection and try again', useResult: 'Use', unsynced: 'Unsynced', instrumental: 'Instrumental', closeSearch: 'Close', songs: 'Songs', addSong: 'Add Song', noSongs: 'No songs yet — use the button above or drop audio files here.', noSongSelected: 'No song selected', trackCount: '{{count}} track(s)', hideSongs: 'Hide songs', showSongs: 'Show songs', filterSongs: 'Search songs or artists', sortBy: 'Sort', sortTitle: 'Title', sortArtist: 'Artist', sortDateAdded: 'Date added', ctxPlay: 'Play', ctxRemove: 'Remove from list', ctxShowInFolder: 'Show in folder', like: 'Like', unlike: 'Unlike', share: 'Share', shareCopied: 'Copied to clipboard', enterFullscreen: 'Fullscreen lyrics', exitFullscreen: 'Exit fullscreen', unknownArtist: 'Unknown Artist', dragResize: 'Drag to resize', nowPlaying: 'Now Playing', monitoring: 'Waveform & Monitoring' },
      subscription: { title: 'Subscription', description: 'Manage your SootheVoice license and plan.', status: 'License Status', plan: 'Plan', trial: 'Trial', validUntil: 'Valid until', daysRemaining: 'Days remaining', features: 'Licensed features', active: '✓ Active', unlicensed: '○ Unlicensed', expired: '✕ Expired', grace: '⚠ Expired (grace period)', graceMessage: 'Your subscription expired; {{count}} day(s) of grace remain.', invalid: '✕ Invalid token', manage: 'Manage Subscription', renew: 'Renew', activateTitle: 'Activate License', renewTitle: 'Renew Subscription', enterKey: 'Enter your license key to unlock all SootheVoice features.', expiredDesc: 'Your subscription has expired. Renew to restore full access.', subscribe: 'Subscribe', subscribeNow: 'Subscribe Now', activateKey: 'Or enter an existing license key', keyPlaceholder: 'SOOTHEVOICE-XXXX-XXXX-XXXX', activating: 'Activating…', subscribeUnlock: 'Subscribe to Unlock', lockDescription: 'SootheVoice requires an active subscription to use AI features. Start with a free 30-day trial.', haveKey: 'Already have a key? Go to the Subscription page.', expiredTitle: 'Subscription Expired', expiredLockDesc: 'Your subscription has lapsed. Renew to restore access to all features.', openCheckout: 'Open payment page',
        choosePlan: 'Choose a plan', choosePayment: 'Payment method', payNow: 'Pay Now',
        // Ticket 34: multi-period plan cards.
        plans: { monthly: 'Monthly', quarterly: 'Quarterly', semi_annual: 'Semi-Annual', annual: 'Annual', trial: 'Trial' },
        planDesc: {
          monthly: 'Billed monthly', quarterly: 'Billed every 3 months',
          semi_annual: 'Billed every 6 months', annual: 'Billed annually — best value',
        },
        discountBadge: 'Save {{percent}}%', bestValue: 'Best Value',
        periodMonths_one: '{{count}} month', periodMonths_other: '{{count}} months',
        chargeSummary: 'You will be charged {{amount}} for {{period}}.',
        plansLoading: 'Loading plans…',
        plansUnavailable: 'Plans are temporarily unavailable. Please try again later.',
        method: { wechat_pay: 'WeChat Pay', alipay: 'Alipay', douyin_pay: 'Douyin Pay', card: 'Bank Card' },
        payWith: 'Pay with {{method}}', methodsLoading: 'Loading payment methods…',
        methodsUnavailable: 'Payment methods are temporarily unavailable. Please try again later.',
        creatingOrder: 'Creating order…', waitingPayment: 'Waiting for payment…',
        waitingWechat: 'Complete payment in the window that opened — scan with WeChat.',
        waitingDouyin: 'Complete payment in the window that opened — scan with Douyin.',
        waitingAlipay: 'Complete payment in the browser window that opened.',
        waitingCard: 'Complete payment in the browser window that opened.',
        cancelPayment: 'Cancel payment', paymentSuccess: '✓ Payment successful — subscription updated!',
        paymentFailed: 'Payment failed or was cancelled.',
        paymentTimeout: 'Payment timed out. Try again, or check the order status later in Payment History.',
        tryAgain: 'Try again',
        paymentWindowClosed: 'The payment window was closed and no successful payment was detected. If you did complete payment, check the order status later in Payment History.',
        historyTitle: 'Payment History', historyEmpty: 'No payment history yet.', historyDate: 'Date',
        historyPlan: 'Plan', historyMethod: 'Method', historyAmount: 'Amount', historyStatus: 'Status',
        orderStatus: { pending: 'Pending', paid: 'Paid', failed: 'Failed', expired: 'Expired' },
      },
      trial: {
        expiredTitle: 'Trial Ended',
        banner: {
          remaining: 'Trial remaining: {{days}} days',
          remainingHours: 'Trial remaining: {{hours}} hours',
          subscribe: 'Subscribe Now',
        },
        subscription: {
          active: 'Your free trial ends in {{days}} days. Subscribe to continue uninterrupted access.',
          expired: 'Your free trial has ended. Choose a plan to continue.',
        },
      },
      onboarding: { welcome: 'Welcome to SootheVoice', welcomeDesc: 'AI Singer Cover Software for training singer models, creating covers, and processing audio.', modelTitle: 'Model Training', modelDesc: 'Upload dry vocal material on the Model Training page to create your own AI singer model.', coverTitle: 'Cover Creation', coverDesc: 'Upload a song, separate vocals and accompaniment, then replace the original vocal with your model.', toolsTitle: 'Audio Tools', toolsDesc: 'Use the batch source separation tool to extract vocals, harmony, and accompaniment.', next: 'Next', skip: 'Skip', getStarted: 'Get Started', progress: '{{current}} / {{total}}', showAgain: 'Show Tutorial Again', dontShow: "Don't show again", start: 'Get Started →', hardware: 'Detecting Hardware', scanning: 'Scanning for GPU acceleration…', continue: 'Continue →', warmup: 'Model Warm-Up', warmupDesc: 'Pre-load the inference engine so your first synthesis is instant.', warmupRunning: 'Initializing the AI engine…', warmupSuccess: '✓ Engine ready. You can start using the app.', warmupContinue: 'Continue', warmupSkip: 'Skip warm-up', runWarmup: 'Run Warm-Up', ready: '✓ Engine ready', warmupFailed: 'Warm-up failed. Continuing in degraded mode.', retryWarmup: 'Retry Warm-Up', allSet: 'You\'re All Set!', allSetDesc: 'SootheVoice is configured and ready.', open: 'Open SootheVoice' },
      errors: { verificationUrl: 'License verification service is not configured.', checkoutUrl: 'Payment page is not configured.', engine: 'Engine error: {{message}}', generic: 'An error occurred: {{message}}' },
      notification: {
        center: { title: 'Notifications', empty: 'No notifications yet', markAllRead: 'Mark all as read', clearAll: 'Clear all' },
        training: {
          complete: { title: 'Training Complete', message: 'Model "{{modelName}}" is ready to use.' },
          failed:   { title: 'Training Failed', message: 'Training did not complete: {{message}}' },
          downloaded: { title: 'Model Downloaded', message: 'Model "{{modelName}}" was encrypted and saved.' },
          downloadFailed: { title: 'Model Download Failed', message: 'Download did not complete: {{message}}' },
        },
        separation: {
          complete: { title: 'Separation Complete', message: 'Stem separation finished ({{mode}}).' },
          failed:   { title: 'Separation Failed', message: 'Stem separation did not complete: {{message}}' },
        },
        separationBatch: {
          complete: { title: 'Batch Separation Complete', message: '{{count}} file(s) finished processing.' },
          failed:   { title: 'Some Separations Failed', message: '{{count}} file(s) failed to process.' },
        },
        synthesis: {
          complete: { title: 'Synthesis Complete', message: 'Cover synthesis finished ({{mode}}).' },
          failed:   { title: 'Synthesis Failed', message: 'Cover synthesis did not complete: {{message}}' },
        },
        highPitchProtection: {
          complete: { title: 'High-Pitch Protection Applied', message: 'Corrected {{count}} high-pitch region(s); protection starts at D#4.' },
          failed:   { title: 'High-Pitch Protection Failed', message: 'High-pitch protection did not complete: {{message}}' },
        },
        trainUpload: {
          complete: { title: 'Training Started', message: 'The training dataset was uploaded and the cloud training job has started.' },
          failed:   { title: 'Upload/Training Failed', message: 'Could not upload the training dataset or start training: {{message}}' },
        },
        trial: {
          activated:    { title: 'Trial Activated', message: 'Your free trial has started — enjoy full access.' },
          expiringSoon: { title: 'Trial Expiring Soon', message: '{{hours}} hour(s) left in your trial. Subscribe to keep going.' },
          expired:      { title: 'Trial Ended', message: 'Your free trial has ended. Choose a plan to continue.' },
        },
        payment: {
          success: { title: 'Payment Successful', message: 'Your subscription has been updated — all features unlocked.' },
        },
        subscription: {
          expiringSoon: { title: 'Subscription Expiring Soon', message: 'Your subscription expires in {{days}} day(s). Renew to avoid interruption.' },
          expired:      { title: 'Subscription Expired', message: 'Your subscription has expired. Renew to restore full access.' },
        },
        system: {
          updateAvailable: { title: 'Update Available', message: 'Version {{version}} is available to download.' },
          updateReady:     { title: 'Update Ready', message: 'Restart the app to finish installing.' },
          // Ticket 37 §1/§4: "Update Check Failed" no longer fires as a
          // notification — failures surface only inline in Settings → Updates.
          welcome:         { title: 'Welcome to SootheVoice', message: 'Start with Model Training to create your own AI singer.' },
          licenseGrace:    { title: 'License Verification Issue', message: "Couldn't verify your subscription right now — entering grace period. Check your connection." },
          rendererRecovered: { title: 'App Recovered', message: 'The interface recovered from an unexpected error. Restart the app if problems continue.' },
        },
        custom: {
          bgUploadFailed: { title: 'Background Upload Failed', message: 'Please try a different image.' },
        },
      },
      settings: {
        title: 'Settings', description: 'Customize the appearance mode, font, theme colour, background image, and your profile photo.',
        appearance: 'Appearance', system: 'System', light: 'Light', dark: 'Dark',
        font: 'Font', fontFamily: { system: 'System Default', sans: 'Sans-serif', serif: 'Serif', mono: 'Monospace' },
        fontSize: 'Font Size', fontSizePreview: 'Preview — font size applies instantly across the whole app.', fontSizePreviewSub: 'Including the lyrics panel and waveform time labels.',
        themeColor: 'Theme Colour',
        accentLabel: 'Accent Colour',
        accent: {
          indigo: 'Indigo', blue: 'Blue', teal: 'Teal', green: 'Green', orange: 'Orange', pink: 'Pink', red: 'Red', violet: 'Violet',
          netease: 'NetEase Red', spotify: 'Spotify Green', applemusic: 'Apple Music Pink', youtube: 'YouTube Red', skyblue: 'Sky Blue',
        },
        customColor: 'Custom colour', customColorHint: 'Pick any colour for the theme accent — hover/active shades are generated automatically.',
        previewButton: 'Primary button', previewTab: 'Active tab', previewLyric: 'Current lyric',
        contrastRatio: 'Contrast {{ratio}}:1',
        background: 'Background Image', uploadBackground: 'Upload Background', removeBackground: 'Remove Background',
        backgroundHint: 'The image is blurred and darkened automatically and used as the app background. Keep it under 10MB.',
        bgTooLarge: 'Image is too large — please choose one under 10MB.', bgInvalid: 'Could not read that image. Please try another.',
        bgUpdated: 'Background updated', bgMissing: 'The background image file is missing; reverted to the default background — please re-upload.',
        bgBlurIntensity: 'Blur intensity', bgOverlayOpacity: 'Overlay opacity',
        bgBrightWarning: 'This image is quite bright — overlay opacity was raised automatically for readability. You can fine-tune it below.',
        profilePhoto: 'Profile Photo', uploadPhoto: 'Upload Photo', removePhoto: 'Remove Photo',
        photoHint: 'A square image works best — it will be auto-cropped and compressed.', photoInvalid: 'Could not read that image. Please try another.',
        about: {
          title: 'About', version: 'Version {{version}}', developer: 'Developer', developerName: 'The SootheVoice Team',
        },
        updates: {
          title: 'Updates', checkButton: 'Check for Updates', checking: 'Checking…',
          upToDate: 'You are up to date.', newVersion: 'New version {{version}} is available.',
          updateNow: 'Update Now', failed: 'Update check failed. Please try again later.',
        },
        notifications: {
          title: 'Notifications', description: 'Manage how task, subscription, and system notifications are shown.', categories: 'Categories',
          category: {
            taskCompletion: 'Task completion', taskFailure: 'Task failure', subscription: 'Subscription & trial',
            system: 'System messages', custom: 'Other alerts',
          },
          duration: 'Toast duration', position: 'Toast position', positionTopRight: 'Top-right', positionBottomRight: 'Bottom-right',
        },
        lyrics: {
          title: 'Lyrics', description: 'Control whether lyrics are matched online automatically when a song loads.',
          autoFetch: 'Automatically fetch lyrics',
          autoFetchHint: 'When a song loads and no local lyrics are found, automatically match and load synced lyrics from an online source.',
        },
      },
    },
  },
} as const

const saved = localStorage.getItem(LANGUAGE_KEY) as SupportedLanguage | null
const hasValidSavedLanguage = saved !== null && SUPPORTED_LANGUAGES.includes(saved)
const initialLanguage: SupportedLanguage = hasValidSavedLanguage ? saved : 'zh-CN'

// Explicitly persist the first-launch default before React mounts the tutorial.
if (!hasValidSavedLanguage) localStorage.setItem(LANGUAGE_KEY, 'zh-CN')

// Synchronous initialization prevents OS locale detection from affecting first paint.
i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: ['zh-CN'],
  interpolation: { escapeValue: false },
})

export default i18n
