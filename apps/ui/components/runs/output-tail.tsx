import type { CapturedOutput } from '@plumb/core';
import { clock } from './format';

/**
 * 마지막 실행 출력 (work-run 3.3). **가로챈 테스트 · 검사 명령의 stdout/stderr 꼬리만** — 에이전트의 메시지 텍스트는 절대 아니다.
 * 없으면 "아직 실행 출력 없음" (5절). 마지막 줄은 그 명령의 종료 시각 · exit code
 */
export function OutputTail({ output }: { output: CapturedOutput | undefined }) {
  if (output === undefined) {
    return (
      <section className="output-tail">
        <h3>마지막 실행 출력</h3>
        <p>아직 실행 출력 없음</p>
      </section>
    );
  }
  return (
    <section className="output-tail">
      <h3>
        마지막 실행 출력 <small>(가로챈 출력 · {output.command})</small>
      </h3>
      <pre>
        {output.tail.map((line, index) => (
          // 꼬리 줄은 같은 내용이 반복될 수 있어 순서가 키다
          // biome-ignore lint/suspicious/noArrayIndexKey: 출력 줄은 순서로만 구별된다
          <div key={index}>│ {line}</div>
        ))}
        <div className="output-foot">
          │ {clock(output.finishedAt)} · exit {output.exitCode}
        </div>
      </pre>
    </section>
  );
}
