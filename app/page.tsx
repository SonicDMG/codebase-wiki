import { redirect } from 'next/navigation';

// The wiki UI still lives at /wiki; this app has nothing else to show at the root.
export default function Home() {
  redirect('/wiki');
}
