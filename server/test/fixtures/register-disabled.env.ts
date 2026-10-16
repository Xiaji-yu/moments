/**
 * 副作用模块：必须在任何生产模块（config.ts）求值之前被 import，
 * 用于「关闭注册」场景的集成测试（ESM 静态 import 按声明顺序求值）。
 */
process.env.REGISTER_ENABLED = 'false';
