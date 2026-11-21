/** Compatibility endpoint for call clients that still use the pre-refresh URL. */
import { POST as tokenPost } from '@/app/api/token/route';

export const revalidate = 0;
export const POST = tokenPost;
