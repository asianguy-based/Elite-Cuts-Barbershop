<?php
/**
 * The main template file
 */

get_header();
?>

<div class="container" style="padding: 4rem 0;">
    <?php
    if (have_posts()) :
        while (have_posts()) : the_post();
    ?>
        <article id="post-<?php the_ID(); ?>" <?php post_class(); ?>>
            <h2><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h2>
            <div class="entry-content">
                <?php the_content(); ?>
            </div>
        </article>
    <?php
        endwhile;
    else :
    ?>
        <p>No content found.</p>
    <?php
    endif;
    ?>
</div>

<?php
get_footer();
