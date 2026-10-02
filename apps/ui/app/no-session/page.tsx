/**
 * 세션 없음 안내 (`/no-session`). 미들웨어가 쿠키 없는 페이지 요청을 여기로 rewrite 한다.
 * 문구는 `docs/screens/work-approve.md` 4절 오류 표의 401 행 그대로.
 */
export default function NoSessionPage() {
  return (
    <>
      <h1>세션이 없습니다</h1>
      <p>
        <code>plumb ui</code> 를 다시 시작하면 브라우저가 <code>/auth</code> 로 열립니다.
      </p>
      <p>
        이 화면의 승인 통로는 <code>plumb ui</code> 가 시작할 때 만든 일회용 토큰으로만 열립니다. 토큰은 브라우저에만
        전달되고, 쿠키가 없는 요청은 전부 401 입니다.
      </p>
    </>
  );
}
