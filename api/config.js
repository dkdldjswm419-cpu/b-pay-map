// GET /api/config: 브라우저용 Supabase 공개 설정 (anon 키는 공개되어도 되는 키)
export function GET() {
  return Response.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
  });
}
