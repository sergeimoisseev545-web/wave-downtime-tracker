document.addEventListener('DOMContentLoaded', () => {
    const faqItems = document.querySelectorAll('.faq-item');

    faqItems.forEach(item => {
        const question = item.querySelector('.faq-question');

        question.addEventListener('click', () => {

            faqItems.forEach(otherItem => {
                if (otherItem !== item && otherItem.classList.contains('active')) {
                    otherItem.classList.remove('active');
                }
            });

            item.classList.toggle('active');
        });
    });

    // Добавление кнопки downgrade в первый FAQ вопрос
    const firstFaqAnswer = document.querySelector('.faq-item:first-child .faq-answer p');
    if (firstFaqAnswer && firstFaqAnswer.textContent.includes('downgrading')) {
        const downgradeBtn = document.createElement('a');
        downgradeBtn.href = '/downgrade';
        downgradeBtn.className = 'faq-downgrade-button';
        downgradeBtn.textContent = 'DOWNGRADE!';
        firstFaqAnswer.appendChild(downgradeBtn);
    }
});