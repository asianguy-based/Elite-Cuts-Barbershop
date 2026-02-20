<?php
/**
 * Template for displaying single barber posts
 */

get_header();
?>

<div class="container" style="padding: 4rem 0;">
    <?php
    while (have_posts()) : the_post();
        $experience = get_post_meta(get_the_ID(), '_barber_experience', true);
        $specialties = get_post_meta(get_the_ID(), '_barber_specialties', true);
        $specialties_array = !empty($specialties) ? array_map('trim', explode(',', $specialties)) : array();
    ?>
    
    <article id="post-<?php the_ID(); ?>" <?php post_class(); ?>>
        <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 3rem; margin-bottom: 3rem;">
            <div>
                <?php if (has_post_thumbnail()) : ?>
                    <?php the_post_thumbnail('large', array('style' => 'width: 100%; height: auto; border-radius: 8px;')); ?>
                <?php endif; ?>
            </div>
            
            <div>
                <h1 style="margin-bottom: 1rem; color: var(--primary);"><?php the_title(); ?></h1>
                
                <?php if ($experience) : ?>
                    <p style="font-size: 1.2rem; color: #666; margin-bottom: 1.5rem;">
                        <?php echo esc_html($experience); ?>
                    </p>
                <?php endif; ?>
                
                <?php if (!empty($specialties_array)) : ?>
                    <div style="margin-bottom: 2rem;">
                        <h3 style="margin-bottom: 1rem;">Specialties:</h3>
                        <div class="specialties">
                            <?php foreach ($specialties_array as $specialty) : ?>
                                <span class="specialty"><?php echo esc_html($specialty); ?></span>
                            <?php endforeach; ?>
                        </div>
                    </div>
                <?php endif; ?>
                
                <div class="entry-content" style="margin-bottom: 2rem;">
                    <?php the_content(); ?>
                </div>
                
                <a href="<?php echo home_url('/#appointment'); ?>" class="btn btn-primary">Book Appointment</a>
            </div>
        </div>
    </article>
    
    <?php endwhile; ?>
</div>

<?php
get_footer();
