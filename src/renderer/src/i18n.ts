import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

export const LANGUAGE_KEY = 'ruanjian.language'
export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

const resources = {
  'zh-CN': {
    translation: {
      app: { title: 'Ruanjian', subtitle: 'AI 歌声工作室', ready: '引擎就绪' },
      language: { label: '语言', zh: '简体中文', en: 'English' },
      nav: { training: '模型训练', cover: '翻唱创作', audioTools: '音频工具', playback: '播放/监听', subscription: '订阅' },
      common: {
        loading: '加载中…', cancel: '取消', retry: '重试', reset: '重置', refresh: '刷新',
        activate: '激活', deactivate: '停用', download: '下载', error: '错误', done: '完成',
        unavailable: '不可用', paymentUnavailable: '支付页面不可用',
      },
      updater: {
        ready: '更新已准备安装', install: '重启并安装', available: '发现更新 {{version}}',
        downloading: '正在下载…', download: '下载',
      },
      status: { running: '正在运行：{{method}}', idle: '引擎就绪', training: '训练中：{{mode}}', separating: '正在分离…', synthesizing: '正在合成（{{mode}}）…', saved: '已保存：{{path}}' },
      training: {
        title: '模型训练', description: '使用干声录音微调 AI 歌手的音色。', info: '模型信息', name: '模型名称 *', namePlaceholder: '例如：我的歌手', epochs: '训练轮数', material: '训练素材', noFiles: '未上传文件，将使用演示数据。', mode: '训练模式', start: '开始本地训练', training: '训练中…', complete: '✓ 训练完成', finalizing: '正在收尾…', finalizingDesc: '训练已完成，正在生成试听音频并保存模型。', audition: '试听', trainAnother: '训练另一个模型', models: '我的模型（{{count}}）', demo: '试听', retrain: '重新训练', delete: '删除', standard: '标准', professional: '专业', gpu: 'GPU', cpu: 'CPU', vram: '显存', epoch: '第 {{current}}/{{total}} 轮', loss: '损失 {{value}}', eta: '预计剩余 {{value}}', waiting: '等待引擎…', materialHint: '拖入干净的人声录音。', standardTagline: 'LoRA rank-4 · 仅训练音色编码器', professionalTagline: 'LoRA+ rank-8 · 全层训练 · 梯度检查点', dropAudio: '拖入音频文件，或点击浏览', audioFormats: 'WAV · FLAC · MP3 · OGG · M4A', fileCount: '{{count}} 个文件', totalDuration: '共 {{duration}}', clearAll: '全部清除', removeFile: '移除文件', loadingWaveform: '正在加载波形…', waveform: '波形', play: '播放', pause: '暂停', volume: '音量', noDemo: '暂无演示音频', lossLabel: '损失：{{value}}', pro: '专业', trainingGpu: 'GPU', trainingCpu: 'CPU', trainingVram: '显存',
      },
      cover: {
        title: '翻唱创作', description: '上传 → 分离 → 合成 → 混音 → 导出', upload: '上传并分离', song: '歌曲文件（WAV / FLAC / MP3）', chooseSong: '点击选择歌曲', separationMode: '分离模式', standard: '标准', enhanced: '增强', standardStems: '2 轨：人声 + 伴奏', enhancedStems: '3 轨：主唱 · 和声 · 伴奏', startSeparation: '开始分离', separating: '分离中…', stems: '音轨 — 点击独奏试听', nextModel: '下一步：选择模型 →', selectModel: '选择 AI 歌手模型', noModels: '还没有训练好的模型。请先前往模型训练。', algorithm: '翻唱算法', v1: 'V1 — 快速', v2: 'V2 — 高精度', synthesize: '合成翻唱', synthesizing: '合成中…', nextSynthesize: '下一步：合成 →', mix: '合成与混音', mixer: '混音台', export: '下一步：导出 →', exportTitle: '导出音频',
        errUploadFirst: '请先上传一首歌曲。', errSelectModel: '请先选择模型。', errRunSeparation: '请先运行分离。',
        labelVocals: '人声', labelAccompaniment: '伴奏', labelLeadDry: '主唱（干声）', labelHarmonyDry: '和声（干声）',
        labelAiVocal: 'AI 人声', labelOrigHarmony: '原始和声', labelAccomp: '伴奏',
        stepUpload: '上传并分离', stepModel: '选择模型', stepMix: '合成与混音', stepExport: '导出',
        stemsLoading: '正在加载音轨…', unsolo: '取消独奏', mixerLoading: '正在加载音频音轨…', reverb: '混音', eqLow: '低音', eqMid: '中音', eqHigh: '高音',
      },
      audioTools: { title: '音频工具', description: '批量音源分离 — 拖入文件、选择模式、全部处理。', detect: '检测设备', drop: '拖入音频文件，或点击浏览', formats: '多个文件 · WAV · FLAC · OGG', files: '{{count}} 个文件', done: '{{count}} 个完成', pending: '{{count}} 个等待', failed: '{{count}} 个失败', process: '处理 {{count}} 个', processing: '处理中…', clear: '清空', pendingStatus: '● 等待中', errorStatus: '✕ 错误', downloadAll: '全部下载（{{count}}）', standard: '标准', enhanced: '增强' },
      playback: { title: '播放/监听', description: '加载音频、分离音轨、对比原唱与 AI 翻唱，并实时录制人声。', trackList: '音轨列表', loadOriginal: '加载原始音频', loadCover: '加载 AI 翻唱', noTracks: '暂无音轨 — 加载音频文件开始。', separate: '分离音轨', separating: '分离中…', separateMode: '分离模式', standard: '标准', enhanced: '增强', mute: '静音', solo: '独奏', volume: '音量', remove: '移除', waveform: '波形显示', zoomIn: '放大', zoomOut: '缩小', play: '播放', pause: '暂停', stop: '停止', abTitle: 'A/B 对比', trackA: '音轨 A', trackB: '音轨 B', switchAB: '切换 A/B', autoAlign: '自动对齐', aligning: '对齐中…', aligned: '已对齐（偏移 {{offset}} 秒）', selectTwoTracks: '请选择两条音轨进行对比', recordingPanel: '实时录音', record: '● 录音', recording: '● 正在录音…', stopRecording: '停止录音', save: '保存录音', discard: '丢弃', micUnavailable: '无法访问麦克风', recordedClip: '录音片段', original: '原始混音', stem: '分离音轨', cover: 'AI 翻唱', clip: '录音', lyrics: '歌词', expand: '展开', collapse: '收起', importLrc: '导入 LRC', searchOnline: '在线搜索', subscribeForSearch: '订阅后可使用在线歌词搜索', noLyrics: '暂无歌词，请导入 .lrc 文件或在线搜索', searchLyricsTitle: '在线搜索歌词', searchQueryPlaceholder: '歌曲名称', searchArtistPlaceholder: '艺术家（可选）', search: '搜索', searching: '搜索中…', searchNoResults: '未找到结果', searchError: '搜索失败，请检查网络连接后重试', useResult: '使用', unsynced: '无时间轴', instrumental: '纯音乐', closeSearch: '关闭', songs: '歌曲列表', addSong: '添加歌曲', noSongs: '暂无歌曲 — 点击上方按钮或将音频文件拖入此处。', noSongSelected: '未选择歌曲', trackCount: '{{count}} 轨', hideSongs: '隐藏歌曲列表', showSongs: '显示歌曲列表', filterSongs: '搜索歌曲或艺术家', sortBy: '排序', sortTitle: '标题', sortArtist: '艺术家', sortDateAdded: '添加时间', ctxPlay: '播放', ctxRemove: '从列表移除', ctxShowInFolder: '在文件夹中显示', like: '喜欢', unlike: '取消喜欢', share: '分享', shareCopied: '已复制到剪贴板', enterFullscreen: '全屏歌词', exitFullscreen: '退出全屏', unknownArtist: '未知艺术家', dragResize: '拖动调整高度', nowPlaying: '正在播放', monitoring: '波形与监听' },
      subscription: { title: '订阅', description: '管理 Ruanjian 许可证和订阅计划。', status: '许可证状态', plan: '计划', monthly: '月度', annual: '年度', trial: '试用', validUntil: '有效期至', daysRemaining: '剩余天数', features: '授权功能', active: '✓ 已激活', unlicensed: '○ 未授权', expired: '✕ 已过期', grace: '⚠ 已过期（宽限期）', graceMessage: '订阅已过期，剩余 {{count}} 天宽限期。', invalid: '✕ 无效令牌', manage: '管理订阅', renew: '续订', activateTitle: '激活许可证', renewTitle: '续订订阅', enterKey: '输入许可证密钥以解锁全部功能。', expiredDesc: '订阅已过期。续订后恢复完整访问。', subscribe: '订阅', subscribeNow: '立即订阅', activateKey: '输入现有许可证密钥', keyPlaceholder: 'RUANJIAN-XXXX-XXXX-XXXX', activating: '激活中…', demo: '演示：使用 RUANJIAN-DEMO-2026 获得 30 天试用。', subscribeUnlock: '订阅解锁', lockDescription: 'Ruanjian 需要有效订阅才能使用 AI 功能。现在开始 30 天免费试用。', haveKey: '已有许可证密钥？请前往订阅页面。', expiredTitle: '订阅已过期', expiredLockDesc: '您的订阅已失效。续订后恢复全部功能。', openCheckout: '打开支付页面',
        choosePlan: '选择计划', choosePayment: '选择支付方式', payNow: '立即支付',
        method: { wechat_pay: '微信支付', alipay: '支付宝', douyin_pay: '抖音支付', card: '银行卡' },
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
      onboarding: { welcome: '欢迎使用 Ruanjian', welcomeDesc: 'AI 歌手翻唱软件，帮助你训练歌手模型、制作翻唱并处理音频。', modelTitle: '模型训练', modelDesc: '在模型训练页面上传干声素材，创建属于你的 AI 歌手模型。', coverTitle: '翻唱创作', coverDesc: '上传歌曲，分离人声与伴奏，再选择模型替换原唱。', toolsTitle: '音频工具', toolsDesc: '使用批量音源分离工具快速提取人声、和声与伴奏。', next: '下一步', skip: '跳过', getStarted: '开始使用', progress: '{{current}} / {{total}}', showAgain: '再次查看使用教程', dontShow: '不再显示',
        start: '开始使用 →', hardware: '检测硬件', scanning: '正在扫描 GPU 加速…', continue: '继续 →', warmup: '模型预热', warmupDesc: '预加载推理引擎，让第一次合成更快。', warmupRunning: '正在初始化 AI 引擎…', warmupSuccess: '✓ 引擎已就绪，可以开始使用。', warmupContinue: '继续', warmupSkip: '跳过预热', runWarmup: '运行预热', ready: '✓ 引擎就绪', warmupFailed: '预热失败，将以降级模式继续。', retryWarmup: '重试预热', allSet: '准备完成！', allSetDesc: 'Ruanjian 已配置完成，可以开始使用。', open: '打开 Ruanjian' },
      errors: { verificationUrl: '许可证验证服务未配置。', checkoutUrl: '支付页面未配置。', engine: '引擎错误：{{message}}', generic: '发生错误：{{message}}' },
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
      },
    },
  },
  'en-US': {
    translation: {
      app: { title: 'Ruanjian', subtitle: 'AI Singing Voice Studio', ready: 'Engine ready' },
      language: { label: 'Language', zh: '简体中文', en: 'English' },
      nav: { training: 'Model Training', cover: 'Cover Creation', audioTools: 'Audio Tools', playback: 'Playback / Monitor', subscription: 'Subscription' },
      common: { loading: 'Loading…', cancel: 'Cancel', retry: 'Retry', reset: 'Reset', refresh: 'Refresh', activate: 'Activate', deactivate: 'Deactivate', download: 'Download', error: 'Error', done: 'Done', unavailable: 'Unavailable', paymentUnavailable: 'Payment page unavailable' },
      updater: { ready: 'Update ready to install', install: 'Restart & Install', available: 'Update {{version}} available', downloading: 'Downloading…', download: 'Download' },
      status: { running: 'Running: {{method}}', idle: 'Engine ready', training: 'Training: {{mode}}', separating: 'Separating…', synthesizing: 'Synthesizing ({{mode}})…', saved: 'Saved: {{path}}' },
      training: { title: 'Model Training', description: 'Fine-tune the AI singer\'s timbre using dry vocal recordings.', info: 'Model Info', name: 'Model name *', namePlaceholder: 'e.g. My Singer', epochs: 'Epochs', material: 'Training Material', noFiles: 'No files uploaded; synthetic demo data will be used.', mode: 'Training Mode', start: 'Start Local Training', training: 'Training…', complete: '✓ Training Complete', finalizing: 'Finalizing…', finalizingDesc: 'Training finished. Generating the demo clip and saving the model.', audition: 'Audition', trainAnother: 'Train Another Model', models: 'Your Models ({{count}})', demo: 'Demo', retrain: 'Retrain', delete: 'Delete', standard: 'Standard', professional: 'Professional', gpu: 'GPU', cpu: 'CPU', vram: 'VRAM', epoch: 'Epoch {{current}}/{{total}}', loss: 'Loss {{value}}', eta: 'ETA {{value}}', waiting: 'Waiting for engine…', materialHint: 'Drop clean vocal recordings here.', standardTagline: 'LoRA rank-4 · timbre encoder only', professionalTagline: 'LoRA+ rank-8 · all layers · gradient checkpointing', dropAudio: 'Drop audio files here, or click to browse', audioFormats: 'WAV · FLAC · MP3 · OGG · M4A', fileCount: '{{count}} file(s)', totalDuration: '{{duration}} total', clearAll: 'Clear all', removeFile: 'Remove file', loadingWaveform: 'Loading waveform…', waveform: 'waveform', play: 'Play', pause: 'Pause', volume: 'Volume', noDemo: 'No demo available', lossLabel: 'Loss: {{value}}', pro: 'Pro', trainingGpu: 'GPU', trainingCpu: 'CPU', trainingVram: 'VRAM' },
      cover: { title: 'Cover Creation', description: 'Upload → Separate → Synthesize → Mix → Export', upload: 'Upload & Separate', song: 'Song file (WAV / FLAC / MP3)', chooseSong: 'Click to choose a song', separationMode: 'Separation mode', standard: 'Standard', enhanced: 'Enhanced', standardStems: '2 stems — vocals + accompaniment', enhancedStems: '3 stems — lead · harmony · accompaniment', startSeparation: 'Start Separation', separating: 'Separating…', stems: 'Stems — click Solo to preview', nextModel: 'Next: Select Model →', selectModel: 'Select AI Singer Model', noModels: 'No models trained yet. Go to Model Training first.', algorithm: 'Cover algorithm', v1: 'V1 — Fast', v2: 'V2 — High-Precision', synthesize: 'Synthesize Cover', synthesizing: 'Synthesizing…', nextSynthesize: 'Next: Synthesize →', mix: 'Synthesize & Mix', mixer: 'Mixing Console', export: 'Next: Export →', exportTitle: 'Export Audio',
        errUploadFirst: 'Please upload a song first.', errSelectModel: 'Select a model first.', errRunSeparation: 'Run separation first.',
        labelVocals: 'Vocals', labelAccompaniment: 'Accompaniment', labelLeadDry: 'Lead (dry)', labelHarmonyDry: 'Harmony (dry)',
        labelAiVocal: 'AI Vocal', labelOrigHarmony: 'Orig. Harmony', labelAccomp: 'Accomp.',
        stepUpload: 'Upload & Separate', stepModel: 'Select Model', stepMix: 'Synthesize & Mix', stepExport: 'Export',
        stemsLoading: 'Loading stems…', unsolo: 'Un-solo', mixerLoading: 'Loading audio tracks…', reverb: 'Reverb', eqLow: 'Lo', eqMid: 'Mid', eqHigh: 'Hi',
      },
      audioTools: { title: 'Audio Tools', description: 'Batch source separation — drop files, choose modes, process all.', detect: 'Detect Device', drop: 'Drop audio files here, or click to browse', formats: 'Multiple files · WAV · FLAC · OGG', files: '{{count}} file(s)', done: '{{count}} done', pending: '{{count}} pending', failed: '{{count}} failed', process: 'Process {{count}}', processing: 'Processing…', clear: 'Clear', pendingStatus: '● Pending', errorStatus: '✕ Error', downloadAll: 'Download All ({{count}})', standard: 'Standard', enhanced: 'Enhanced' },
      playback: { title: 'Playback / Monitor', description: 'Load audio, separate stems, A/B compare the original vocal against an AI cover, and record your voice live.', trackList: 'Track List', loadOriginal: 'Load Original Audio', loadCover: 'Load AI Cover', noTracks: 'No tracks yet — load an audio file to get started.', separate: 'Separate', separating: 'Separating…', separateMode: 'Separation mode', standard: 'Standard', enhanced: 'Enhanced', mute: 'Mute', solo: 'Solo', volume: 'Volume', remove: 'Remove', waveform: 'Waveform', zoomIn: 'Zoom in', zoomOut: 'Zoom out', play: 'Play', pause: 'Pause', stop: 'Stop', abTitle: 'A/B Comparison', trackA: 'Track A', trackB: 'Track B', switchAB: 'Switch A/B', autoAlign: 'Auto-Align', aligning: 'Aligning…', aligned: 'Aligned (offset {{offset}}s)', selectTwoTracks: 'Select two tracks to compare', recordingPanel: 'Live Recording', record: '● Record', recording: '● Recording…', stopRecording: 'Stop Recording', save: 'Save Recording', discard: 'Discard', micUnavailable: 'Microphone unavailable', recordedClip: 'Recorded clip', original: 'Original Mix', stem: 'Stem', cover: 'AI Cover', clip: 'Recording', lyrics: 'Lyrics', expand: 'Expand', collapse: 'Collapse', importLrc: 'Import LRC', searchOnline: 'Search Online', subscribeForSearch: 'Subscribe to use online lyrics search', noLyrics: 'No lyrics — import a .lrc file or search online', searchLyricsTitle: 'Search Lyrics Online', searchQueryPlaceholder: 'Song title', searchArtistPlaceholder: 'Artist (optional)', search: 'Search', searching: 'Searching…', searchNoResults: 'No results found', searchError: 'Search failed — check your connection and try again', useResult: 'Use', unsynced: 'Unsynced', instrumental: 'Instrumental', closeSearch: 'Close', songs: 'Songs', addSong: 'Add Song', noSongs: 'No songs yet — use the button above or drop audio files here.', noSongSelected: 'No song selected', trackCount: '{{count}} track(s)', hideSongs: 'Hide songs', showSongs: 'Show songs', filterSongs: 'Search songs or artists', sortBy: 'Sort', sortTitle: 'Title', sortArtist: 'Artist', sortDateAdded: 'Date added', ctxPlay: 'Play', ctxRemove: 'Remove from list', ctxShowInFolder: 'Show in folder', like: 'Like', unlike: 'Unlike', share: 'Share', shareCopied: 'Copied to clipboard', enterFullscreen: 'Fullscreen lyrics', exitFullscreen: 'Exit fullscreen', unknownArtist: 'Unknown Artist', dragResize: 'Drag to resize', nowPlaying: 'Now Playing', monitoring: 'Waveform & Monitoring' },
      subscription: { title: 'Subscription', description: 'Manage your Ruanjian license and plan.', status: 'License Status', plan: 'Plan', monthly: 'Monthly', annual: 'Annual', trial: 'Trial', validUntil: 'Valid until', daysRemaining: 'Days remaining', features: 'Licensed features', active: '✓ Active', unlicensed: '○ Unlicensed', expired: '✕ Expired', grace: '⚠ Expired (grace period)', graceMessage: 'Your subscription expired; {{count}} day(s) of grace remain.', invalid: '✕ Invalid token', manage: 'Manage Subscription', renew: 'Renew', activateTitle: 'Activate License', renewTitle: 'Renew Subscription', enterKey: 'Enter your license key to unlock all Ruanjian features.', expiredDesc: 'Your subscription has expired. Renew to restore full access.', subscribe: 'Subscribe', subscribeNow: 'Subscribe Now', activateKey: 'Or enter an existing license key', keyPlaceholder: 'RUANJIAN-XXXX-XXXX-XXXX', activating: 'Activating…', demo: 'Demo: use RUANJIAN-DEMO-2026 for a free 30-day trial.', subscribeUnlock: 'Subscribe to Unlock', lockDescription: 'Ruanjian requires an active subscription to use AI features. Start with a free 30-day trial.', haveKey: 'Already have a key? Go to the Subscription page.', expiredTitle: 'Subscription Expired', expiredLockDesc: 'Your subscription has lapsed. Renew to restore access to all features.', openCheckout: 'Open payment page',
        choosePlan: 'Choose a plan', choosePayment: 'Payment method', payNow: 'Pay Now',
        method: { wechat_pay: 'WeChat Pay', alipay: 'Alipay', douyin_pay: 'Douyin Pay', card: 'Bank Card' },
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
      onboarding: { welcome: 'Welcome to Ruanjian', welcomeDesc: 'AI Singer Cover Software for training singer models, creating covers, and processing audio.', modelTitle: 'Model Training', modelDesc: 'Upload dry vocal material on the Model Training page to create your own AI singer model.', coverTitle: 'Cover Creation', coverDesc: 'Upload a song, separate vocals and accompaniment, then replace the original vocal with your model.', toolsTitle: 'Audio Tools', toolsDesc: 'Use the batch source separation tool to extract vocals, harmony, and accompaniment.', next: 'Next', skip: 'Skip', getStarted: 'Get Started', progress: '{{current}} / {{total}}', showAgain: 'Show Tutorial Again', dontShow: "Don't show again", start: 'Get Started →', hardware: 'Detecting Hardware', scanning: 'Scanning for GPU acceleration…', continue: 'Continue →', warmup: 'Model Warm-Up', warmupDesc: 'Pre-load the inference engine so your first synthesis is instant.', warmupRunning: 'Initializing the AI engine…', warmupSuccess: '✓ Engine ready. You can start using the app.', warmupContinue: 'Continue', warmupSkip: 'Skip warm-up', runWarmup: 'Run Warm-Up', ready: '✓ Engine ready', warmupFailed: 'Warm-up failed. Continuing in degraded mode.', retryWarmup: 'Retry Warm-Up', allSet: 'You\'re All Set!', allSetDesc: 'Ruanjian is configured and ready.', open: 'Open Ruanjian' },
      errors: { verificationUrl: 'License verification service is not configured.', checkoutUrl: 'Payment page is not configured.', engine: 'Engine error: {{message}}', generic: 'An error occurred: {{message}}' },
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
