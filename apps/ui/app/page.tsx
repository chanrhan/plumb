import { redirect } from 'next/navigation';

/** `/` 는 `/views` 로 보낸다 (docs/screens/README.md 1절: 매일 여는 화면) */
export default function Home() {
  redirect('/views');
}
