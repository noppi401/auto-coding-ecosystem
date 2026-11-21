import { config } from 'dotenv';
import { resolve } from 'path';

// .env を、ほかのどのモジュールよりも先に読み込む。
// ACE_LANG（i18n の locale）や ECOSYSTEM_LOG_PATH などは、モジュールの読み込み時に値が決まるため、
// index.ts の本文で読み込むと間に合わない。index.ts では最初に import すること。
config({ path: resolve('.env') });
